// js/net/FirebaseClient.js — the ONLY module that touches Firebase CDN URLs.
// Initializes the app + Firestore once and re-exports `db` plus every
// firestore function the rest of js/net/ needs. No DOM, no three.js.
//
// Firebase JS SDK v10.12.0 modular, loaded from gstatic CDN (no build step).

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getFirestore,
  doc,
  collection,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  addDoc,
  query,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);

/** Shared Firestore instance for the whole app. @type {import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js').Firestore} */
export const db = getFirestore(app);

// Re-export the firestore surface so no other net module imports the CDN.
export {
  doc,
  collection,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  addDoc,
  query,
};
