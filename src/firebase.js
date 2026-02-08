/**
 * Firebase 初始化與 emotion_records 寫入
 * 整合現有 Firebase 架構，寫入 Firestore Collection: emotion_records
 */

import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  addDoc,
  serverTimestamp,
} from 'firebase/firestore';

// TODO: 替換為實際的 Firebase 設定（與 Squat Analysis 專案相同）
const firebaseConfig = {
  apiKey: "AIzaSyB6wcFs5gSiNDCSweKcEzgRpbIAAb5I3Vo",
  authDomain: "smart-squat-health.firebaseapp.com",
  projectId: "smart-squat-health",
  storageBucket: "smart-squat-health.firebasestorage.app",
  messagingSenderId: "475970550783",
  appId: "1:475970550783:web:2d7dcacb2e55b562eb05ca",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

/**
 * 將檢測紀錄寫入 Firestore emotion_records
 * @param {Object} data - 符合 Schema 的資料物件
 * @returns {Promise<string>} 新增文件的 ID
 */
export async function saveRecord(data) {
  const docRef = await addDoc(collection(db, 'emotion_records'), {
    user_info: {
      name: data.user_info.name,
      age: Number(data.user_info.age),
      timestamp: serverTimestamp(),
      platform: 'Web POC',
    },
    biomarkers: {
      baseline_stability: Number(data.biomarkers.baseline_stability),
      smile_metrics: {
        peak_intensity: Number(data.biomarkers.smile_metrics.peak_intensity),
        latency_ms: Number(data.biomarkers.smile_metrics.latency_ms),
        symmetry: Number(data.biomarkers.smile_metrics.symmetry),
      },
      frown_metrics: {
        peak_intensity: Number(data.biomarkers.frown_metrics.peak_intensity),
        latency_ms: Number(data.biomarkers.frown_metrics.latency_ms),
      },
      blink_rate: Number(data.biomarkers.blink_rate),
    },
    raw_data_summary: String(data.raw_data_summary),
  });
  return docRef.id;
}

export { db };
