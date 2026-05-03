import { getImageBlob } from "./storage.js";

const API_TIMEOUT_MS = 60_000;
const MODEL_STORAGE_KEY = "mixboard_image_model";

const DEFAULT_CONFIG = {
  AI_PROVIDER: "pollinations",
  POLLINATIONS_API_BASE_URL: "https://gen.pollinations.ai",
  POLLINATIONS_API_KEY: "",
  GH_MODELS_TOKEN: "",
  POLLINATIONS_IMAGE_MODEL: "kontext",
  GITHUB_TOKEN: ""
};

const FALLBACK_IMAGE_MODELS = [
  { value: "kontext", label: "kontext (image+edit)", paidOnly: false, supportsImageInput: true, supportsImageOutput: true },
  { value: "flux", label: "flux (image-gen)", paidOnly: false, supportsImageInput: false, supportsImageOutput: true },
  { value: "gptimage", label: "gptimage (image-gen)", paidOnly: false, supportsImageInput: false, supportsImageOutput: true }
];

function getPersistedModel() {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(MODEL_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function setPersistedModel(modelName) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(MODEL_STORAGE_KEY, modelName);
  } catch {
  }
}

function getConfig() {
  if (typeof window === "undefined") {
    return { ...DEFAULT_CONFIG };
  }

  const runtime = window.MIXBOARD_CONFIG || window.POSE_EDITOR_CONFIG || {};
  const persistedModel = getPersistedModel();

  return {
    ...DEFAULT_CONFIG,
    ...runtime,
    POLLINATIONS_IMAGE_MODEL: persistedModel || runtime.POLLINATIONS_IMAGE_MODEL || DEFAULT_CONFIG.POLLINATIONS_IMAGE_MODEL
  };
}

export function getSelectedImageModel() {
  return getConfig().POLLINATIONS_IMAGE_MODEL || "kontext";
}

export function setSelectedImageModel(modelName) {
  if (!modelName || typeof window === "undefined") return;
  if (!window.MIXBOARD_CONFIG) window.MIXBOARD_CONFIG = {};
  window.MIXBOARD_CONFIG.POLLINATIONS_IMAGE_MODEL = modelName;
  setPersistedModel(modelName);
}

function normalizeBaseUrl(url) {
  return String(url || "").replace(/\/$/, "");
}

function parseCostNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toModelOption(model) {
  const completionImageCost = parseCostNumber(model?.pricing?.completionImageTokens);
  const costLabel = completionImageCost !== null ? `${completionImageCost.toExponential(2)} pollen/img` : "cost: n/a";
  const supportsImageInput = Array.isArray(model?.input_modalities) && model.input_modalities.includes("image");
  const capability = supportsImageInput ? "image+edit" : "image-gen";
  const paidTag = model?.paid_only ? " paid" : "";
  return {
    value: model.name,
    label: `${model.name} (${capability}${paidTag}, ${costLabel})`,
    paidOnly: !!model?.paid_only,
    supportsImageInput,
    supportsImageOutput: Array.isArray(model?.output_modalities) && model.output_modalities.includes("image")
  };
}

export async function fetchImageModels() {
  const config = getConfig();
  const baseUrl = normalizeBaseUrl(config.POLLINATIONS_API_BASE_URL);

  try {
    const response = await fetch(`${baseUrl}/image/models`);
    if (!response.ok) {
      throw new Error(`Image model fetch failed: ${response.status}`);
    }

    const catalog = await response.json();
    if (!Array.isArray(catalog)) {
      throw new Error("Unexpected model response.");
    }

    return catalog
      .filter((model) => model && typeof model.name === "string")
      .map(toModelOption)
      .filter((model) => model.supportsImageOutput)
      .sort((a, b) => a.label.localeCompare(b.label));
  } catch {
    return [...FALLBACK_IMAGE_MODELS];
  }
}

function getApiKey(config) {
  const key = config.POLLINATIONS_API_KEY || config.GH_MODELS_TOKEN || "";

  // GitHub Actions ephemeral tokens (ghs_) are not valid Pollinations API keys.
  if (typeof key === "string" && key.startsWith("ghs_")) {
    throw new Error("Invalid token type detected (ghs_). Use POLLINATIONS_API_KEY or GH_MODELS_TOKEN instead.");
  }

  return key;
}

function buildPollinationsHeaders(apiKey) {
  const headers = {
    "Content-Type": "application/json"
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

function aspectToSize(aspectRatio) {
  switch (aspectRatio) {
    case "3:4":
      return "960x1280";
    case "4:3":
      return "1280x960";
    case "9:16":
      return "720x1280";
    case "16:9":
      return "1280x720";
    default:
      return "1024x1024";
  }
}

function aspectToDimensions(aspectRatio) {
  const size = aspectToSize(aspectRatio);
  const [w, h] = size.split("x").map((n) => Number.parseInt(n, 10));
  return {
    width: Number.isFinite(w) ? w : 1024,
    height: Number.isFinite(h) ? h : 1024
  };
}

async function parseErrorResponse(response) {
  try {
    const data = await response.json();
    return data?.error?.message || data?.message || `${response.status} ${response.statusText}`;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

async function postJson(url, options) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(await parseErrorResponse(response));
    }

    return await response.json();
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      throw new Error("Request timed out after 60 s. Please try again.");
    }
    throw err;
  }
}

async function generateWithWebsim(prompt, aspectRatio, imageInputs) {
  if (typeof websim === "undefined" || !websim.imageGen) {
    return null;
  }

  const result = await websim.imageGen({
    prompt,
    aspect_ratio: aspectRatio,
    image_inputs: imageInputs.length ? imageInputs : undefined
  });

  return result && result.url ? result.url : null;
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to decode reference image."));
    img.src = src;
  });
}

async function buildEditReferenceImage(imageInputs) {
  if (!imageInputs.length) return null;
  if (imageInputs.length === 1) return imageInputs[0].url;

  // Pollinations edits endpoint is most stable with a single image input.
  // Merge multiple selected images into one 2x2 reference sheet.
  const refs = await Promise.all(imageInputs.slice(0, 4).map((item) => loadImageElement(item.url)));
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Unable to build reference collage for image edit.");
  }

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const cells = refs.length === 2 ? [
    { x: 0, y: 0, w: 512, h: 1024 },
    { x: 512, y: 0, w: 512, h: 1024 }
  ] : refs.length === 3 ? [
    { x: 0, y: 0, w: 512, h: 512 },
    { x: 512, y: 0, w: 512, h: 512 },
    { x: 256, y: 512, w: 512, h: 512 }
  ] : [
    { x: 0, y: 0, w: 512, h: 512 },
    { x: 512, y: 0, w: 512, h: 512 },
    { x: 0, y: 512, w: 512, h: 512 },
    { x: 512, y: 512, w: 512, h: 512 }
  ];

  refs.forEach((img, idx) => {
    const cell = cells[idx];
    const ratio = Math.min(cell.w / img.width, cell.h / img.height);
    const drawW = img.width * ratio;
    const drawH = img.height * ratio;
    const drawX = cell.x + (cell.w - drawW) / 2;
    const drawY = cell.y + (cell.h - drawH) / 2;
    ctx.drawImage(img, drawX, drawY, drawW, drawH);
  });

  return canvas.toDataURL("image/png");
}

async function generateWithPollinations(prompt, aspectRatio, imageInputs, config) {
  const key = getApiKey(config);

  const baseUrl = normalizeBaseUrl(config.POLLINATIONS_API_BASE_URL);
  const size = aspectToSize(aspectRatio);

  if (!key) {
    if (imageInputs.length) {
      throw new Error("AI generation is not configured for image editing. Set POLLINATIONS_API_KEY or GH_MODELS_TOKEN in runtime config (local) and repo secrets (Pages).");
    }

    const { width, height } = aspectToDimensions(aspectRatio);
    const publicBase = "https://image.pollinations.ai/prompt";
    // Public endpoint is most reliable with flux when no API key is present.
    const model = "flux";
    const encodedPrompt = encodeURIComponent(prompt || "Generate an image");
    const publicUrl = `${publicBase}/${encodedPrompt}?model=${model}&width=${width}&height=${height}&nologo=true`;
    return publicUrl;
  }

  let result;
  if (imageInputs.length) {
    const editReferenceImage = await buildEditReferenceImage(imageInputs);
    const payload = {
      model: config.POLLINATIONS_IMAGE_MODEL || "kontext",
      prompt,
      image: editReferenceImage,
      size
    };
    result = await postJson(`${baseUrl}/v1/images/edits`, {
      method: "POST",
      headers: buildPollinationsHeaders(key),
      body: JSON.stringify(payload)
    });
  } else {
    const payload = {
      model: config.POLLINATIONS_IMAGE_MODEL || "kontext",
      prompt,
      size
    };
    result = await postJson(`${baseUrl}/v1/images/generations`, {
      method: "POST",
      headers: buildPollinationsHeaders(key),
      body: JSON.stringify(payload)
    });
  }

  const imageData = result?.data?.[0];
  if (imageData?.url) {
    return imageData.url;
  }
  if (imageData?.b64_json) {
    return `data:image/png;base64,${imageData.b64_json}`;
  }
  return null;
}

export async function describeImagesIfNeeded(selected, freeMode) {
  if (!freeMode) return { descriptions: {} };
  const descriptions = {};
  for (const n of selected) {
    if (n.type === "image" && n.imageBlobUrl) {
      const base64 = await urlToDataUrl(n.imageBlobUrl);
      const completion = await websim.chat.completions.create({
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Describe this image in 1-2 sentences, factual and concise." },
            { type: "image_url", image_url: { url: base64 } }
          ],
        }],
      });
      console.log("[describeImages] node", n.id, "desc len:", completion.content?.length, "freeMode:", freeMode);
      descriptions[n.id] = completion.content.trim();
    }
  }
  return { descriptions };
}

export async function generateNodesFromSelection(selected, descriptions, freeMode, aspect) {
  console.log("[generateNodes] start", { count: selected.length, freeMode, hasDescs: Object.keys(descriptions||{}).length });
  const texts = [];
  const imageInputs = []; // collect base64 images for imageGen in non-free mode

  // Build text parts and base64 images
  for (const n of selected) {
    if (n.type === "text") texts.push(n.text || "");
    if (n.type === "image") {
      // Prefer raw blob from storage to avoid fetch(blob:) issues
      let base64 = null;
      if (!freeMode && n.imageId) {
        const blob = await getImageBlob(n.imageId);
        if (blob) {
          base64 = await blobToDataUrl(blob);
        }
        console.log("[generateNodes] blob size", blob?.size, "id:", n.imageId);
      }
      // Fallback to existing object URL if blob not available
      if (!base64 && n.imageBlobUrl) {
        base64 = await urlToDataUrl(n.imageBlobUrl);
        console.log("[generateNodes] from objectURL len", base64?.length, "id:", n.id);
      }

      if (freeMode) {
        const d = descriptions[n.id] || "(no description)";
        texts.push(`Image described: ${d}`);
      } else if (base64 && imageInputs.length < 4) {
        imageInputs.push({ url: base64 });
      }
    }
  }

  console.log("[generateNodes] imageInputs", imageInputs.map(i => i.url.length));
  console.log("[generateNodes] texts lengths", texts.map(t => (t || "").length));

  const appendedText = texts.join("\n").trim();
  const prompt = appendedText || "Create a visual based on the selected inputs.";

  // Determine aspect ratio: use provided aspect string; if missing, default 1:1
  const aspect_ratio = (typeof aspect === "string" && ["1:1","3:4","4:3","9:16","16:9"].includes(aspect)) ? aspect : "1:1";
  console.log("[imageGen] prompt:", prompt, "aspect_ratio:", aspect_ratio, "refImgs:", imageInputs.length);

  const config = getConfig();
  const provider = config.AI_PROVIDER || "pollinations";
  const effectiveInputs = (!freeMode && imageInputs.length) ? imageInputs : [];

  let generatedUrl = null;
  let websimError = null;

  try {
    generatedUrl = await generateWithWebsim(prompt, aspect_ratio, effectiveInputs);
  } catch (err) {
    websimError = err;
    console.warn("[imageGen] websim provider failed", err);
  }

  if (!generatedUrl && provider === "pollinations") {
    try {
      generatedUrl = await generateWithPollinations(prompt, aspect_ratio, effectiveInputs, config);
    } catch (pollinationsError) {
      if (websimError) {
        throw new Error(`Generation failed on both providers. Websim: ${websimError.message}. Pollinations: ${pollinationsError.message}`);
      }
      throw pollinationsError;
    }
  }

  if (!generatedUrl && websimError) {
    throw new Error(`Websim generation failed: ${websimError.message}`);
  }

  if (!generatedUrl) {
    throw new Error("No image URL returned from generation provider.");
  }

  // Determine display size for the new node
  let w = 256, h = 256;
  const firstImg = selected.find(n => n.type === "image");
  if (aspect === "auto" && firstImg) {
    w = firstImg.w; h = firstImg.h;
  } else {
    switch (aspect_ratio) {
      case "3:4": w = 240; h = 320; break;
      case "4:3": w = 320; h = 240; break;
      case "9:16": w = 270; h = 480; break;
      case "16:9": w = 480; h = 270; break;
      default: w = 256; h = 256; break;
    }
  }
  const outputs = [{ type: "image", url: generatedUrl, aspect_ratio }];
  console.log("[generateNodes] outputs", outputs.map(o => ({ type:o.type, aspect_ratio:aspect_ratio, url: o.url?.slice(0,60) })));
  return outputs;
}

async function urlToDataUrl(url) {
  const response = await fetch(url);
  const blob = await response.blob();
  return blobToDataUrl(blob);
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}