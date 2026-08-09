const DATABASE_NAME = "mosecapy-inputs";
const DATABASE_VERSION = 1;
const STORE_NAME = "youtube-audio";
const ACTIVE_AUDIO_KEY = "active";

type StoredYouTubeAudio = {
  blob: Blob;
  filename: string;
  lastModified: number;
  type: string;
  url: string;
};

export type CachedYouTubeAudio = {
  file: File;
  url: string;
};

export async function cacheYouTubeAudio(file: File, url: string): Promise<void> {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const completed = transactionComplete(transaction);
    transaction.objectStore(STORE_NAME).put({
      blob: file,
      filename: file.name,
      lastModified: file.lastModified,
      type: file.type,
      url,
    } satisfies StoredYouTubeAudio, ACTIVE_AUDIO_KEY);
    await completed;
  } finally {
    database.close();
  }
}

export async function loadCachedYouTubeAudio(): Promise<CachedYouTubeAudio | null> {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const [stored] = await Promise.all([
      requestResult<StoredYouTubeAudio | undefined>(transaction.objectStore(STORE_NAME).get(ACTIVE_AUDIO_KEY)),
      transactionComplete(transaction),
    ]);

    if (!stored || !(stored.blob instanceof Blob) || typeof stored.filename !== "string" || typeof stored.url !== "string") {
      return null;
    }

    return {
      file: new File([stored.blob], stored.filename, {
        type: stored.type || stored.blob.type || "audio/mpeg",
        lastModified: stored.lastModified,
      }),
      url: stored.url,
    };
  } finally {
    database.close();
  }
}

export async function clearCachedYouTubeAudio(): Promise<void> {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const completed = transactionComplete(transaction);
    transaction.objectStore(STORE_NAME).delete(ACTIVE_AUDIO_KEY);
    await completed;
  } finally {
    database.close();
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("The input cache could not be opened."));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("The cached input could not be read."));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("The input cache transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("The input cache transaction was aborted."));
  });
}
