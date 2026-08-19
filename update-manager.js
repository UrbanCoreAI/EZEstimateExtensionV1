// EZ Estimate - Self-update manager
//
// Core logic for the "Check for Updates" system: fetch → unzip → sanitize →
// write, kept separate from any UI so it can be exercised directly (e.g. from
// an extension page's devtools console) with a crafted zip ArrayBuffer:
//
//   const buf = await (await fetch('test.zip')).arrayBuffer();
//   const raw = EZUpdateManager.unzipBuffer(buf);
//   const clean = EZUpdateManager.sanitizeEntries(raw);   // throws on any zip-slip entry
//
// Loaded as a plain (non-module) script in popup.html and options.html, and
// via importScripts() from background.js — this file never bundles or is
// bundled by a build tool, so it must not use import/export.
//
// IMPORTANT: only fetchVersionInfo()/checkVersionOnly() are safe to call from
// background.js's service-worker context. unzipBuffer() needs `self.fflate`
// (lib/fflate.umd.js), which is only loaded on the popup/options pages, and
// getDirectoryHandle()/writeEntries() use the File System Access API, which
// service workers cannot invoke a permission prompt for anyway.
(function (root) {
  'use strict';

  // ---- Configuration ------------------------------------------------------
  // Public Storage URL for the "extension-updates" bucket in the same
  // Supabase project background.js already uses for job_quantities. See
  // AUTO-UPDATE-SETUP.md for how to create the bucket and wire up the
  // publish workflow that fills it.
  var UPDATE_BASE_URL = 'https://fujddlemswhbdqrhpekt.supabase.co/storage/v1/object/public/extension-updates';
  var VERSION_URL = UPDATE_BASE_URL + '/version.json';
  var ZIP_URL = UPDATE_BASE_URL + '/latest.zip';

  var VERSION_STORAGE_KEY = 'ezUpdateInstalledVersion';

  var DB_NAME = 'ez-update-db';
  var DB_VERSION = 1;
  var DB_STORE = 'handles';
  var DB_KEY = 'updateFolder';

  // ---- Typed errors ---------------------------------------------------
  // popup.js switches on `error.name` to show a distinct, human-readable
  // message per failure mode instead of one generic "something went wrong".
  function defineError(name) {
    function CustomError(message) {
      this.name = name;
      this.message = message;
      this.stack = (new Error(message)).stack;
    }
    CustomError.prototype = Object.create(Error.prototype);
    CustomError.prototype.constructor = CustomError;
    return CustomError;
  }

  var NetworkError = defineError('NetworkError');
  var InvalidZipError = defineError('InvalidZipError');
  var PathTraversalError = defineError('PathTraversalError');
  var PermissionError = defineError('PermissionError');
  var FolderMissingError = defineError('FolderMissingError');
  var NoFolderSetError = defineError('NoFolderSetError');

  // ---- IndexedDB directory-handle storage ------------------------------
  // FileSystemDirectoryHandle can't go in chrome.storage (not JSON-safe),
  // but it can be structured-cloned into IndexedDB and read back from any
  // page on the same extension origin (popup, options, or the service
  // worker) — that's how the options-page setup step hands the handle to
  // the popup's update button.
  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(DB_STORE)) {
          req.result.createObjectStore(DB_STORE);
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbGet(key) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, 'readonly');
        var req = tx.objectStore(DB_STORE).get(key);
        req.onsuccess = function () { resolve(req.result === undefined ? null : req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function idbSet(key, value) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(value, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function idbDelete(key) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).delete(key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function getDirectoryHandle() { return idbGet(DB_KEY); }
  function setDirectoryHandle(handle) { return idbSet(DB_KEY, handle); }
  function clearDirectoryHandle() { return idbDelete(DB_KEY); }

  // ---- Installed-version storage (chrome.storage.local) ------------------
  function getInstalledVersion() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(VERSION_STORAGE_KEY, function (cfg) {
        resolve((cfg && cfg[VERSION_STORAGE_KEY]) || 0);
      });
    });
  }

  function setInstalledVersion(v) {
    return new Promise(function (resolve) {
      var set = {};
      set[VERSION_STORAGE_KEY] = v;
      chrome.storage.local.set(set, resolve);
    });
  }

  // ---- Network -----------------------------------------------------------
  async function fetchVersionInfo() {
    var res;
    try {
      res = await fetch(VERSION_URL, { cache: 'no-store' });
    } catch (e) {
      throw new NetworkError('Could not reach the update server — check your internet connection.');
    }
    if (!res.ok) {
      throw new NetworkError('Update server returned an error (HTTP ' + res.status + ') while checking for updates.');
    }
    try {
      return await res.json();
    } catch (e) {
      throw new NetworkError('Update server returned an unreadable version file.');
    }
  }

  async function fetchZipBuffer() {
    var res;
    try {
      res = await fetch(ZIP_URL, { cache: 'no-store' });
    } catch (e) {
      throw new NetworkError('Could not download the update package — check your internet connection.');
    }
    if (!res.ok) {
      throw new NetworkError('Failed to download the update package (HTTP ' + res.status + ').');
    }
    return res.arrayBuffer();
  }

  // ---- Unzip + path-traversal sanitization --------------------------------
  function unzipBuffer(arrayBuffer) {
    if (!root.fflate || typeof root.fflate.unzipSync !== 'function') {
      throw new InvalidZipError('Zip library is not loaded on this page.');
    }
    var entries;
    try {
      entries = root.fflate.unzipSync(new Uint8Array(arrayBuffer));
    } catch (e) {
      throw new InvalidZipError('The downloaded update package is corrupted or not a valid zip file.');
    }
    if (!entries || Object.keys(entries).length === 0) {
      throw new InvalidZipError('The downloaded update package is empty.');
    }
    return entries;
  }

  // Rejects (and aborts on the first bad entry, before any file is written)
  // any zip entry path that could escape the target directory: absolute
  // paths, drive-letter paths, or any ".." path segment. Directory-only
  // entries (paths ending in "/") are skipped — they're created implicitly
  // when a file underneath them is written.
  function sanitizeEntries(rawEntries) {
    var clean = {};
    var paths = Object.keys(rawEntries);
    for (var i = 0; i < paths.length; i++) {
      var rawPath = paths[i];
      if (rawPath.charAt(rawPath.length - 1) === '/') continue; // directory placeholder

      var normalized = rawPath.replace(/\\/g, '/');
      var segments = normalized.split('/');
      var isUnsafe =
        normalized === '' ||
        normalized.charAt(0) === '/' ||
        /^[a-zA-Z]:/.test(normalized) || // e.g. "C:/Windows/..." smuggled into an entry name
        segments.indexOf('..') !== -1 ||
        segments.indexOf('') !== -1; // empty segment, e.g. "foo//bar"

      if (isUnsafe) {
        throw new PathTraversalError('Update rejected — package contains an unsafe file path ("' + rawPath + '"). No files were written.');
      }
      clean[normalized] = rawEntries[rawPath];
    }
    return clean;
  }

  // ---- Folder existence + permission -----------------------------------
  // queryPermission() only reflects the browser's permission grant, not
  // whether the target directory still exists on disk — a rename/delete
  // outside the browser doesn't revoke permission. Actually listing the
  // directory is what surfaces a NotFoundError for a moved/deleted folder.
  async function verifyFolderExists(dirHandle) {
    try {
      var iterator = dirHandle.values();
      await iterator.next();
    } catch (e) {
      throw new FolderMissingError('The update folder could not be found — it may have been renamed, moved, or deleted. Redo setup in Settings.');
    }
  }

  async function queryFolderPermission(dirHandle) {
    try {
      return await dirHandle.queryPermission({ mode: 'readwrite' });
    } catch (e) {
      return 'denied';
    }
  }

  // Only ever call this from a page opened by a direct user gesture
  // (the options page's own button click) — never from the popup, since
  // the permission prompt it can show is enough to steal focus and close
  // the popup mid-flow.
  async function requestFolderPermission(dirHandle) {
    return dirHandle.requestPermission({ mode: 'readwrite' });
  }

  // ---- Writing files -------------------------------------------------
  async function writeEntries(dirHandle, cleanEntries) {
    var paths = Object.keys(cleanEntries);
    for (var i = 0; i < paths.length; i++) {
      var path = paths[i];
      var data = cleanEntries[path];
      var segments = path.split('/').filter(Boolean);
      var fileName = segments.pop();
      var dir = dirHandle;
      try {
        for (var s = 0; s < segments.length; s++) {
          dir = await dir.getDirectoryHandle(segments[s], { create: true });
        }
        var fileHandle = await dir.getFileHandle(fileName, { create: true });
        var writable = await fileHandle.createWritable();
        await writable.write(data);
        await writable.close();
      } catch (e) {
        if (e && e.name === 'NotAllowedError') {
          throw new PermissionError('Permission to the update folder was revoked mid-update. The folder may now contain a partial update — re-authorize and click Check for Updates again to finish applying it.');
        }
        if (e && e.name === 'NotFoundError') {
          throw new FolderMissingError('The update folder disappeared mid-update — it may have been renamed, moved, or deleted. Redo setup in Settings, then click Check for Updates again.');
        }
        throw e;
      }
    }
  }

  // ---- Orchestration -----------------------------------------------------
  // Runs the full check-and-apply flow. `onProgress(stage)` is optional and
  // called with one of: 'checking' | 'downloading' | 'unzipping' | 'writing'.
  //
  // Note on atomicity: entries are validated in full (sanitizeEntries) before
  // any write begins, so a malformed/malicious zip never touches disk. Once
  // writing starts, though, the File System Access API has no transaction —
  // if permission is revoked or the folder vanishes mid-write, files already
  // written stay written. That's why the installed-version number is only
  // bumped after every file succeeds: a later click just re-runs the same
  // (idempotent, full-fileset) write and self-heals rather than being told
  // it's "up to date" with a half-applied folder.
  async function checkAndApplyUpdate(onProgress) {
    var notify = onProgress || function () {};

    var dirHandle = await getDirectoryHandle();
    if (!dirHandle) {
      throw new NoFolderSetError('No update folder has been set up yet.');
    }

    var permission = await queryFolderPermission(dirHandle);
    if (permission !== 'granted') {
      throw new PermissionError('Update folder access needs to be re-authorized.');
    }

    await verifyFolderExists(dirHandle);

    notify('checking');
    var versionInfo = await fetchVersionInfo();
    var remoteVersion = Number(versionInfo && versionInfo.version) || 0;
    var localVersion = await getInstalledVersion();

    if (remoteVersion <= localVersion) {
      return { status: 'up-to-date', localVersion: localVersion };
    }

    notify('downloading');
    var zipBuffer = await fetchZipBuffer();

    notify('unzipping');
    var rawEntries = unzipBuffer(zipBuffer);
    var cleanEntries = sanitizeEntries(rawEntries);

    notify('writing');
    await writeEntries(dirHandle, cleanEntries);

    await setInstalledVersion(remoteVersion);

    return { status: 'updated', newVersion: remoteVersion, previousVersion: localVersion };
  }

  // Lightweight check used by background.js's hourly alarm — only compares
  // version numbers over the network, never touches the directory handle or
  // fflate, so it's safe to run from the service-worker context.
  async function checkVersionOnly() {
    var versionInfo = await fetchVersionInfo();
    var remoteVersion = Number(versionInfo && versionInfo.version) || 0;
    var localVersion = await getInstalledVersion();
    return { remoteVersion: remoteVersion, localVersion: localVersion, hasUpdate: remoteVersion > localVersion };
  }

  root.EZUpdateManager = {
    // config
    VERSION_URL: VERSION_URL,
    ZIP_URL: ZIP_URL,
    // errors (exposed so callers/tests can `instanceof` check them)
    NetworkError: NetworkError,
    InvalidZipError: InvalidZipError,
    PathTraversalError: PathTraversalError,
    PermissionError: PermissionError,
    FolderMissingError: FolderMissingError,
    NoFolderSetError: NoFolderSetError,
    // handle storage (used by options.js setup flow + popup.js)
    getDirectoryHandle: getDirectoryHandle,
    setDirectoryHandle: setDirectoryHandle,
    clearDirectoryHandle: clearDirectoryHandle,
    queryFolderPermission: queryFolderPermission,
    requestFolderPermission: requestFolderPermission,
    verifyFolderExists: verifyFolderExists,
    // version storage
    getInstalledVersion: getInstalledVersion,
    setInstalledVersion: setInstalledVersion,
    // pure/testable pieces
    fetchVersionInfo: fetchVersionInfo,
    fetchZipBuffer: fetchZipBuffer,
    unzipBuffer: unzipBuffer,
    sanitizeEntries: sanitizeEntries,
    writeEntries: writeEntries,
    // orchestrators
    checkAndApplyUpdate: checkAndApplyUpdate,
    checkVersionOnly: checkVersionOnly
  };
})(typeof self !== 'undefined' ? self : this);
