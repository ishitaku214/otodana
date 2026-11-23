"use strict";

const trackStore = {
  async open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("otodana-library", 4);
      request.onupgradeneeded = ({ oldVersion }) => {
        if (oldVersion === 0) request.result.createObjectStore("tracks", { keyPath: "id", autoIncrement: true });
        if (oldVersion < 2) request.result.createObjectStore("settings");
        if (oldVersion < 3) request.result.createObjectStore("trackDetails", { keyPath: "id" });
        request.transaction.objectStore("tracks").createIndex("pcTransferId", "pcTransferId", { unique: true });
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () => reject(request.error);
    });
  },

  addTransfer(database, track, edits) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(["tracks", "trackDetails"], "readwrite");
      const request = transaction.objectStore("tracks").add(track);
      if (edits) request.onsuccess = () => transaction.objectStore("trackDetails").put({ id: request.result, edits });
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? request.error);
    });
  },

  run(database, mode, operation, store = "tracks") {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(store, mode);
      const request = operation(transaction.objectStore(store));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? request.error);
    });
  },

  updateDetails(database, id, update) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(["tracks", "trackDetails"], "readwrite");
      const store = transaction.objectStore("trackDetails");
      const exists = transaction.objectStore("tracks").getKey(id);
      exists.onsuccess = () => {
        if (exists.result === undefined) {
          transaction.abort();
          return;
        }
        const request = store.get(id);
        request.onsuccess = () => {
          const details = request.result ?? { id };
          update(details);
          store.put(details);
        };
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  },

  deleteTracks(database, ids) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(["tracks", "trackDetails"], "readwrite");
      const tracks = transaction.objectStore("tracks");
      const details = transaction.objectStore("trackDetails");
      for (const id of ids) {
        tracks.delete(id);
        details.delete(id);
      }
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  },
};
