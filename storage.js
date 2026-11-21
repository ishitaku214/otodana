"use strict";

const trackStore = {
  async open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("otodana-library", 2);
      request.onupgradeneeded = ({ oldVersion }) => {
        if (oldVersion === 0) request.result.createObjectStore("tracks", { keyPath: "id", autoIncrement: true });
        request.result.createObjectStore("settings");
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () => reject(request.error);
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
};
