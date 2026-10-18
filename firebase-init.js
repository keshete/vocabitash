// ---------------------------------------------------------------------------
// This is the ONLY file in this project that knows Firebase (or any specific
// backend) exists. It re-implements the four Claude-Artifact "capabilities"
// the original app was built against — db, user, sample, downloads — using
// real Firebase + a tiny serverless API route, with the exact same method
// shapes (db.doc().set()/.update()/.delete(), db.collection().add()/.doc()/
// .onSnapshot(), sampleFn.json(), downloadsCap.save()). Because of that,
// app.js (everything below "sign-in / boot" near its end) did not need to
// change at all when this app moved out of Claude Artifacts.
//
// Fill in firebase-config.js with your own project's config (see README.md)
// before this will work.
// ---------------------------------------------------------------------------

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut as fbSignOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore, doc, setDoc, updateDoc, deleteDoc, getDoc, collection, addDoc, onSnapshot,
  query, where, getDocs,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const fs = getFirestore(app);

// ---- db shim: mirrors the Artifact `db` capability's doc()/collection() API ----
// Extended (beyond the original Artifact shape) with .get() and .where() so
// the app can do one-time reads and scoped queries — used by the circles
// feature below. Everything else is unchanged from the original shim.
function wrapDoc(path) {
  const ref = doc(fs, path);
  return {
    set: (data, opts) => setDoc(ref, data, opts || {}),
    update: (data) => updateDoc(ref, data),
    delete: () => deleteDoc(ref),
    get: () => getDoc(ref),
    collection: (name) => wrapCollection(`${path}/${name}`),
  };
}
function wrapQuery(ref) {
  return {
    where: (field, op, value) => wrapQuery(query(ref, where(field, op, value))),
    onSnapshot: (onNext, onError) => onSnapshot(ref, onNext, onError || (() => {})),
    get: () => getDocs(ref),
  };
}
function wrapCollection(path) {
  const ref = collection(fs, path);
  return {
    add: async (data) => ({ id: (await addDoc(ref, data)).id }),
    doc: (id) => wrapDoc(`${path}/${id}`),
    onSnapshot: (onNext, onError) => onSnapshot(ref, onNext, onError || (() => {})),
    where: (field, op, value) => wrapQuery(query(ref, where(field, op, value))),
    get: () => getDocs(ref),
  };
}
const dbShim = {
  doc: (path) => wrapDoc(path),
  collection: (path) => wrapCollection(path),
};

// ---- sample shim: mirrors the Artifact `sample` capability's .json()/.limits() ----
// Calls our own tiny serverless function (api/extract-words.js) instead of
// Claude directly, so the Anthropic API key never reaches the browser.
// Images go up as base64 inside a plain JSON body — no multipart-parsing
// library needed on the (very small) serverless function side.
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
const sampleCache = new Map(); // prompt -> {at, value}  (session-only, best effort)
const sampleShim = {
  limits: async () => ({ images: { maxCount: 6 } }),
  json: async (prompt, opts = {}) => {
    if (opts.cache && opts.cache !== false) {
      const hit = sampleCache.get(prompt);
      const ttl = (opts.cache && opts.cache.gcTime) || 0;
      if (hit && (!ttl || Date.now() - hit.at < ttl)) return hit.value;
    }
    const images = await Promise.all(
      (opts.images || []).map(async (file) => ({
        mediaType: file.type || "image/jpeg",
        data: await fileToBase64(file),
      }))
    );
    const res = await fetch("/api/extract-words", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, images }),
    });
    let body;
    try { body = await res.json(); } catch (e) { throw { code: "invalid_json", message: "Bad response" }; }
    if (!res.ok) throw body.error || { code: "unavailable", message: "Request failed" };
    if (opts.cache !== false) sampleCache.set(prompt, { at: Date.now(), value: body.result });
    return body.result;
  },
};

// ---- downloads shim: mirrors the Artifact `downloads` capability's .save() ----
const downloadsShim = {
  save: async ({ filename, data }) => {
    const blob = data instanceof Blob ? data : new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { status: "saved" };
  },
};

// ---- auth: Google sign-in only, on purpose — see README.md ----
export const shims = {
  db: dbShim,
  sample: sampleShim,
  downloads: downloadsShim,
  signIn: () => signInWithPopup(auth, new GoogleAuthProvider()),
  signOut: () => fbSignOut(auth),
  onAuthChange: (cb) => onAuthStateChanged(auth, cb),
};
