import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  getDoc,
  getDocFromServer,
  setDoc,
  collection,
  query,
  limit as firestoreLimit,
  getDocs,
  onSnapshot,
  Unsubscribe,
  where
} from 'firebase/firestore';
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged,
  User
} from 'firebase/auth';
import firebaseConfig from '../firebase-applet-config.json';

// Initialize Firebase
const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

// CRITICAL: Must pass firestoreDatabaseId from firebase-applet-config.json
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map((provider) => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Test connection on boot per Firebase skill guidelines
export async function testConnection(): Promise<boolean> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.warn('Firebase client is offline or network restricted.');
      return false;
    }
    // Any other response (including PERMISSION_DENIED or NOT_FOUND) means server is reached
    return true;
  }
}

// --- Data Types ---
export interface SpsaCloudConfig {
  id?: string;
  aggression: number;
  riskTolerance: number;
  styleWindow: number;
  materialWeight: number;
  mobilityWeight: number;
  kingSafetyWeight: number;
  passedPawnsWeight: number;
  spaceWeight: number;
  tempoBonus: number;
  generation?: number;
  isPublic: boolean;
  updatedBy?: string;
  updatedAt?: string;
}

export interface GameCloudRecord {
  id?: string;
  gameMode: 'PlayVsEngine' | 'SandboxDuel';
  whiteEngine: string;
  blackEngine: string;
  result: '1-0' | '0-1' | '1/2-1/2' | '*';
  reason?: string;
  movesCount: number;
  pgn: string;
  fen: string;
  isPublic: boolean;
  userId?: string;
  createdAt?: string;
}

const LOCAL_STORAGE_SPSA_KEY = 'berserker_spsa_state_v2';
const LOCAL_STORAGE_GAMES_KEY = 'berserker_games_history_v2';

// --- SPSA State Persistence ---

/**
 * Saves SPSA parameters to Firestore and local storage.
 * Runs asynchronously without blocking engine processes.
 */
export async function saveSpsaConfig(config: Partial<SpsaCloudConfig>): Promise<void> {
  const payload: SpsaCloudConfig = {
    id: 'spsa_main',
    aggression: typeof config.aggression === 'number' ? config.aggression : 160,
    riskTolerance: typeof config.riskTolerance === 'number' ? config.riskTolerance : 110,
    styleWindow: typeof config.styleWindow === 'number' ? config.styleWindow : 95,
    materialWeight: typeof config.materialWeight === 'number' ? config.materialWeight : 100,
    mobilityWeight: typeof config.mobilityWeight === 'number' ? config.mobilityWeight : 45,
    kingSafetyWeight: typeof config.kingSafetyWeight === 'number' ? config.kingSafetyWeight : 75,
    passedPawnsWeight: typeof config.passedPawnsWeight === 'number' ? config.passedPawnsWeight : 55,
    spaceWeight: typeof config.spaceWeight === 'number' ? config.spaceWeight : 35,
    tempoBonus: typeof config.tempoBonus === 'number' ? config.tempoBonus : 28,
    generation: typeof config.generation === 'number' ? config.generation : 1,
    isPublic: true,
    updatedBy: auth.currentUser?.displayName || auth.currentUser?.email || 'Berserker Engine Architect',
    updatedAt: new Date().toISOString()
  };

  // Immediate local cache
  try {
    localStorage.setItem(LOCAL_STORAGE_SPSA_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn('Could not cache SPSA state to localStorage', e);
  }

  // Cloud Firestore Persistence
  const docPath = 'engine_configs/spsa_main';
  try {
    await setDoc(doc(db, 'engine_configs', 'spsa_main'), payload);
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, docPath);
  }
}

/**
 * Loads the latest SPSA configuration from Cloud Firestore (falls back to local storage).
 */
export async function loadLatestSpsaConfig(): Promise<SpsaCloudConfig | null> {
  const docPath = 'engine_configs/spsa_main';
  try {
    const docSnap = await getDoc(doc(db, 'engine_configs', 'spsa_main'));
    if (docSnap.exists()) {
      const data = docSnap.data() as SpsaCloudConfig;
      try {
        localStorage.setItem(LOCAL_STORAGE_SPSA_KEY, JSON.stringify(data));
      } catch {
        // silent local write
      }
      return data;
    }
  } catch (error) {
    console.warn('Falling back to local SPSA cache due to cloud load notice:', error);
  }

  // Fallback to local storage if offline or initial load
  try {
    const cached = localStorage.getItem(LOCAL_STORAGE_SPSA_KEY);
    if (cached) {
      return JSON.parse(cached) as SpsaCloudConfig;
    }
  } catch {
    // Ignore JSON parse errors
  }

  return null;
}

/**
 * Real-time listener for SPSA configuration updates.
 */
export function subscribeSpsaConfig(
  onUpdate: (config: SpsaCloudConfig) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const docPath = 'engine_configs/spsa_main';
  return onSnapshot(
    doc(db, 'engine_configs', 'spsa_main'),
    (snap) => {
      if (snap.exists()) {
        const data = snap.data() as SpsaCloudConfig;
        onUpdate(data);
      }
    },
    (error) => {
      onError?.(error);
      handleFirestoreError(error, OperationType.GET, docPath);
    }
  );
}

// --- Game History Persistence ---

/**
 * Saves a completed chess game to Firestore.
 */
export async function saveGameRecord(
  game: Omit<GameCloudRecord, 'id' | 'createdAt'>
): Promise<string> {
  const sanitizedId = `game_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const record: GameCloudRecord = {
    ...game,
    id: sanitizedId,
    isPublic: true,
    userId: auth.currentUser?.uid || 'guest_berserker',
    createdAt: new Date().toISOString(),
    pgn: game.pgn.slice(0, 20000), // Enforce length boundary
    fen: game.fen.slice(0, 200),
    whiteEngine: game.whiteEngine.slice(0, 100),
    blackEngine: game.blackEngine.slice(0, 100),
    reason: game.reason ? game.reason.slice(0, 200) : undefined
  };

  // Local storage cache for instant offline review
  try {
    const existingStr = localStorage.getItem(LOCAL_STORAGE_GAMES_KEY);
    const existingList: GameCloudRecord[] = existingStr ? JSON.parse(existingStr) : [];
    existingList.unshift(record);
    localStorage.setItem(LOCAL_STORAGE_GAMES_KEY, JSON.stringify(existingList.slice(0, 50)));
  } catch (e) {
    console.warn('Could not cache game to local storage', e);
  }

  // Cloud Firestore Persistence
  const docPath = `games/${sanitizedId}`;
  try {
    await setDoc(doc(db, 'games', sanitizedId), record);
    return sanitizedId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, docPath);
  }
}

/**
 * Fetches recent games from Firestore with fallback to local cache.
 */
export async function fetchRecentGames(limitCount = 20): Promise<GameCloudRecord[]> {
  const collectionPath = 'games';
  try {
    const q = query(
      collection(db, collectionPath),
      where('isPublic', '==', true),
      firestoreLimit(Math.min(limitCount, 50))
    );
    const snap = await getDocs(q);
    const games: GameCloudRecord[] = [];
    snap.forEach((d) => {
      games.push(d.data() as GameCloudRecord);
    });

    if (games.length > 0) {
      // Sort client-side by date if available
      games.sort((a, b) => {
        const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return timeB - timeA;
      });
      return games;
    }
  } catch (error) {
    console.warn('Could not fetch cloud games, falling back to local history:', error);
  }

  // Fallback to local storage
  try {
    const cached = localStorage.getItem(LOCAL_STORAGE_GAMES_KEY);
    if (cached) {
      return JSON.parse(cached) as GameCloudRecord[];
    }
  } catch {
    // Ignore parse errors
  }

  return [];
}

/**
 * Subscribes to real-time game history updates.
 */
export function subscribeRecentGames(
  onUpdate: (games: GameCloudRecord[]) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const collectionPath = 'games';
  const q = query(
    collection(db, collectionPath),
    where('isPublic', '==', true),
    firestoreLimit(25)
  );

  return onSnapshot(
    q,
    (snapshot) => {
      const games: GameCloudRecord[] = [];
      snapshot.forEach((d) => {
        games.push(d.data() as GameCloudRecord);
      });
      games.sort((a, b) => {
        const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return timeB - timeA;
      });
      onUpdate(games);
    },
    (error) => {
      onError?.(error);
      handleFirestoreError(error, OperationType.LIST, collectionPath);
    }
  );
}

// --- Google Authentication Services ---

export async function loginWithGoogle(): Promise<User> {
  const provider = new GoogleAuthProvider();
  try {
    const result = await signInWithPopup(auth, provider);
    return result.user;
  } catch (error) {
    console.error('Google Sign In failed:', error);
    throw error;
  }
}

export async function logoutUser(): Promise<void> {
  try {
    await signOut(auth);
  } catch (error) {
    console.error('Sign Out error:', error);
    throw error;
  }
}

export function subscribeAuth(callback: (user: User | null) => void): Unsubscribe {
  return onAuthStateChanged(auth, callback);
}

// Run non-blocking connection check on initialization
testConnection().then((connected) => {
  if (connected) {
    console.log('Level 2 Cloud Persistence: Firebase Firestore connection verified.');
  }
});
