"use strict";

const trackStore = {
  async open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("otodana-library", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("tracks", { keyPath: "id", autoIncrement: true });
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () => reject(request.error);
    });
  },

  run(database, mode, operation) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction("tracks", mode);
      const request = operation(transaction.objectStore("tracks"));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? request.error);
    });
  },
};
