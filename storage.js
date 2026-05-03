import { set as idbSet, get as idbGet, del as idbDel } from "idb-keyval";

const LS_KEY = "ai_canvas_v1";

export async function saveCanvas(state) {
  const { nodes, freeMode } = state;
  const lightweight = nodes.map(n => {
    const { imageId, imageBlobUrl, selected, ...rest } = n; // strip volatile fields
    return imageId ? { ...rest, imageId } : rest;
  });
  localStorage.setItem(LS_KEY, JSON.stringify({ nodes: lightweight, freeMode: !!freeMode }));
}

export function loadCanvas() {
  const raw = localStorage.getItem(LS_KEY);
  if (!raw) return { nodes: [], freeMode: false };
  try {
    const parsed = JSON.parse(raw);
    return {
      nodes: parsed.nodes || [],
      freeMode: !!parsed.freeMode,
    };
  } catch {
    return { nodes: [], freeMode: false };
  }
}

export async function storeImageBlob(id, blob) {
  await idbSet(id, blob);
  return id;
}

export async function getImageBlobUrl(id) {
  const blob = await idbGet(id);
  if (!blob) return null;
  return URL.createObjectURL(blob);
}

export async function deleteImage(id) {
  await idbDel(id);
}

// NEW: get raw blob for reliable base64 conversion (avoids fetching blob: URLs)
export async function getImageBlob(id) {
  return idbGet(id);
}