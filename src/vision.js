/**
 * MediaPipe Face Landmarker 封裝
 * 用於偵測臉部表情、微笑、皺眉、眨眼等 blendshape 數值
 */

import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const MODEL_PATH =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm';

let faceLandmarker = null;

/**
 * 初始化 Face Landmarker（需開啟 outputFaceBlendshapes）
 */
export async function initFaceLandmarker() {
  if (faceLandmarker) return faceLandmarker;

  const vision = await FilesetResolver.forVisionTasks(WASM_PATH);
  faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: MODEL_PATH,
    },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
  });

  return faceLandmarker;
}

/**
 * 從 categories 陣列取得指定名稱的數值
 * MediaPipe faceBlendshapes[0].categories 是 Array，必須用 .find() 讀取
 */
function getShapeValue(categories, categoryName) {
  if (!categories || !Array.isArray(categories)) return 0;
  const shape = categories.find((c) => c.categoryName === categoryName);
  return shape ? shape.score : 0;
}

/**
 * 從 faceBlendshapes 物件取得指定 blendshape 數值
 * 支援 faceBlendshapes[0] 結構（含 .categories 或本身即陣列）
 */
function getBlendshapeValue(blendshapes, name) {
  const categories = blendshapes?.categories ?? (Array.isArray(blendshapes) ? blendshapes : []);
  return getShapeValue(categories, name);
}

/**
 * 取得微笑強度 (mouthSmileLeft + mouthSmileRight) / 2，範圍 0-1
 */
export function getSmileIntensity(blendshapes) {
  const left = getBlendshapeValue(blendshapes, 'mouthSmileLeft');
  const right = getBlendshapeValue(blendshapes, 'mouthSmileRight');
  return (left + right) / 2;
}

/**
 * 取得皺眉強度（複合指標，取最大值）
 * 涵蓋三種負面表情特徵：眉毛下壓、眉頭深鎖、嘴角下撇
 */
export function getFrownIntensity(blendshapes) {
  const browDown =
    (getBlendshapeValue(blendshapes, 'browDownLeft') +
      getBlendshapeValue(blendshapes, 'browDownRight')) /
    2;
  const browInnerUp = getBlendshapeValue(blendshapes, 'browInnerUp'); // 眉頭深鎖（單一 blendshape）
  const mouthFrown =
    (getBlendshapeValue(blendshapes, 'mouthFrownLeft') +
      getBlendshapeValue(blendshapes, 'mouthFrownRight')) /
    2; // 悲傷嘴角
  return Math.max(browDown, browInnerUp, mouthFrown);
}

/**
 * 取得眨眼強度 (eyeBlinkLeft + eyeBlinkRight) / 2
 */
export function getBlinkIntensity(blendshapes) {
  const left = getBlendshapeValue(blendshapes, 'eyeBlinkLeft');
  const right = getBlendshapeValue(blendshapes, 'eyeBlinkRight');
  return (left + right) / 2;
}

/**
 * 取得微笑左右對稱性：1 - |left - right| / (left + right + epsilon)
 */
export function getSmileSymmetry(blendshapes) {
  const left = getBlendshapeValue(blendshapes, 'mouthSmileLeft');
  const right = getBlendshapeValue(blendshapes, 'mouthSmileRight');
  const sum = left + right + 1e-6;
  const asymmetry = Math.abs(left - right) / sum;
  return Math.max(0, 1 - asymmetry);
}

/**
 * 取得微笑原始值 (mouthSmileLeft + mouthSmileRight)，供即時監控使用
 */
export function getSmileRaw(blendshapes) {
  const left = getBlendshapeValue(blendshapes, 'mouthSmileLeft');
  const right = getBlendshapeValue(blendshapes, 'mouthSmileRight');
  return { left, right, sum: left + right };
}

/**
 * 取得皺眉原始值（複合指標），供即時監控使用
 */
export function getFrownRaw(blendshapes) {
  const browDown =
    (getBlendshapeValue(blendshapes, 'browDownLeft') +
      getBlendshapeValue(blendshapes, 'browDownRight')) /
    2;
  const browInnerUp = getBlendshapeValue(blendshapes, 'browInnerUp');
  const mouthFrown =
    (getBlendshapeValue(blendshapes, 'mouthFrownLeft') +
      getBlendshapeValue(blendshapes, 'mouthFrownRight')) /
    2;
  const sum = Math.max(browDown, browInnerUp, mouthFrown);
  return { browDown, browInnerUp, mouthFrown, sum };
}

/**
 * 對單一 video frame 執行偵測，回傳 blendshapes
 * @param {HTMLVideoElement} video
 * @param {number} timestampMs - 影片時間戳（毫秒，必須遞增）
 * @returns {Array|null} faceBlendshapes 或 null
 */
export function detectForVideo(video, timestampMs) {
  if (!faceLandmarker || !video.videoWidth) return null;
  try {
    const result = faceLandmarker.detectForVideo(video, timestampMs);
    if (result.faceLandmarks?.length && result.faceBlendshapes?.length) {
      return result.faceBlendshapes[0];
    }
  } catch (e) {
    console.warn('FaceLandmarker detect error:', e);
  }
  return null;
}
