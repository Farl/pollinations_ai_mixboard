import { jsxDEV } from "react/jsx-dev-runtime";
import React, { useEffect, useRef, useState } from "react";
import { uuid, placeNonOverlapping, withinMarquee } from "./utils.js";
import { saveCanvas, loadCanvas, storeImageBlob, getImageBlobUrl, deleteImage } from "./storage.js";
import { describeImagesIfNeeded, fetchImageModels, generateNodesFromSelection, getSelectedImageModel, setSelectedImageModel } from "./ai.js";

function getGenerationErrorMessage(error) {
  const raw = String(error?.message || "Unknown generation error.");

  if (/timed out/i.test(raw)) {
    return "Generation timed out after 60s. Try fewer references or a simpler prompt.";
  }
  if (/not configured|api key|github_token|gh_models_token/i.test(raw)) {
    return "Missing API key. Configure POLLINATIONS_API_KEY (or GH_MODELS_TOKEN/GITHUB_TOKEN).";
  }
  if (/401|403|unauthorized|forbidden|invalid key/i.test(raw)) {
    return "Authentication failed. Please verify your model provider token/key.";
  }
  if (/429|rate limit|quota/i.test(raw)) {
    return "Rate limited by provider. Please wait and retry.";
  }

  return raw.length > 180 ? `${raw.slice(0, 177)}...` : raw;
}

function CanvasApp() {
  const initialState = loadCanvas();
  const [nodes, setNodes] = useState(() => {
    const arr = (initialState.nodes || []).map((n) => ({ ...n, selected: false }));
    if (arr.length === 0) {
      const pos = placeNonOverlapping(arr, 60, 60, 220, 120);
      arr.push({ id: uuid(), type: "text", x: pos.x, y: pos.y, w: pos.w, h: pos.h, text: "Generate a original cartoon cat", selected: false });
    }
    return arr;
  });
  const [freeMode, setFreeMode] = useState(!!initialState.freeMode);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const canvasRef = useRef(null);
  const dragRef = useRef(null);
  const marqueeRef = useRef(null);
  const spaceDownRef = useRef(false);
  const [isPanning, setIsPanning] = useState(false);
  const worldRef = useRef(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [genSize, setGenSize] = useState({ width: 256, height: 256 });
  const [genInput, setGenInput] = useState({ width: "256", height: "256" });
  const [scale, setScale] = useState(1);
  const [marquee, setMarquee] = useState(null);
  const [aspect, setAspect] = useState("1:1");
  const [showWarn, setShowWarn] = useState(false);
  const [modelOptions, setModelOptions] = useState([]);
  const [modelCatalogLoading, setModelCatalogLoading] = useState(true);
  const [showPaidModels, setShowPaidModels] = useState(false);
  const [selectedModel, setSelectedModel] = useState(() => getSelectedImageModel());
  const visibleModels = modelOptions.filter((model) => showPaidModels || !model.paidOnly);
  function toWorldPoint(clientX, clientY) {
    const rect = canvasRef.current?.getBoundingClientRect?.();
    const sx = rect ? clientX - rect.left : clientX;
    const sy = rect ? clientY - rect.top : clientY;
    return { x: (sx + pan.x) / scale, y: (sy + pan.y) / scale };
  }
  function zoomAtScreenPoint(screenX, screenY, nextScale) {
    const s1 = scale;
    const s2 = Math.max(0.25, Math.min(4, nextScale));
    if (s2 === s1) return;
    const k = s2 / s1;
    const panX2 = pan.x * k + screenX * (k - 1);
    const panY2 = pan.y * k + screenY * (k - 1);
    setScale(s2);
    setPan({ x: panX2, y: panY2 });
  }
  function onWheelCanvas(e) {
    e.preventDefault();
    const rect = canvasRef.current.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const factor = e.deltaY > 0 ? 1 / 1.1 : 1.1;
    const nextScale = scale * factor;
    zoomAtScreenPoint(sx, sy, nextScale);
  }
  function fitToContent() {
    const canvasEl = canvasRef.current;
    if (!canvasEl) return;
    const viewW = canvasEl.clientWidth;
    const viewH = canvasEl.clientHeight;
    const content = nodes;
    if (!content.length) {
      setScale(1);
      setPan({ x: 0, y: 0 });
      return;
    }
    const minX = Math.min(...content.map((n) => n.x));
    const minY = Math.min(...content.map((n) => n.y));
    const maxX = Math.max(...content.map((n) => n.x + n.w));
    const maxY = Math.max(...content.map((n) => n.y + n.h));
    const bboxW = Math.max(1, maxX - minX);
    const bboxH = Math.max(1, maxY - minY);
    const margin = 24;
    const s = Math.max(0.25, Math.min(4, Math.min((viewW - margin) / bboxW, (viewH - margin) / bboxH)));
    const centerWorldX = (minX + maxX) / 2;
    const centerWorldY = (minY + maxY) / 2;
    const centerScreenX = viewW / 2;
    const centerScreenY = viewH / 2;
    const newPanX = centerWorldX * s - centerScreenX;
    const newPanY = centerWorldY * s - centerScreenY;
    setScale(s);
    setPan({ x: newPanX, y: newPanY });
  }
  useEffect(() => {
    (async () => {
      const updated = await Promise.all(nodes.map(async (n) => {
        if (n.type === "image" && n.imageId && !n.imageBlobUrl) {
          const url = await getImageBlobUrl(n.imageId);
          return { ...n, imageBlobUrl: url };
        }
        return n;
      }));
      setNodes(updated);
    })();
  }, []);
  useEffect(() => {
    (async () => {
      try {
        setModelCatalogLoading(true);
        const catalog = await fetchImageModels();
        setModelOptions(catalog);
      } finally {
        setModelCatalogLoading(false);
      }
    })();
  }, []);
  useEffect(() => {
    if (!visibleModels.length) return;
    const activeExists = visibleModels.some((model) => model.value === selectedModel);
    if (!activeExists) {
      setSelectedModel(visibleModels[0].value);
    }
  }, [showPaidModels, modelOptions]);
  useEffect(() => {
    if (selectedModel) {
      setSelectedImageModel(selectedModel);
    }
  }, [selectedModel]);
  useEffect(() => {
    saveCanvas({ nodes, freeMode });
  }, [nodes, freeMode]);
  useEffect(() => {
    const onPaste = async (e) => {
      const items = e.clipboardData?.items || [];
      for (const it of items) {
        if (it.kind === "file") {
          const file = it.getAsFile();
          if (file) await addImageFile(file, 120, 120);
        } else if (it.kind === "string") {
          it.getAsString((text) => {
            const t = (text || "").trim();
            if (t) addTextNode(t);
          });
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);
  useEffect(() => {
    const onKey = async (e) => {
      if (e.code === "Space") {
        spaceDownRef.current = true;
        if (canvasRef.current) {
          canvasRef.current.style.cursor = "grab";
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        await executeAI();
      }
      if (e.key === "Escape") clearSelection();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setNodes((prev) => prev.map((n) => ({ ...n, selected: true })));
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        const el = document.activeElement;
        const isTyping = el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" && (el.type === "text" || el.type === "search" || el.type === "email" || el.type === "url"));
        if (isTyping) return;
        e.preventDefault();
        deleteSelected();
      }
    };
    const onKeyUp = (e) => {
      if (e.code === "Space") {
        spaceDownRef.current = false;
        setIsPanning(false);
        if (canvasRef.current) {
          canvasRef.current.style.cursor = spaceDownRef.current ? "grab" : "default";
        }
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [nodes, freeMode]);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const handler = (e) => onWheelCanvas(e);
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [scale, pan]);
  async function addImageFile(file, w = 180, h = 180) {
    try {
      const id = uuid();
      await storeImageBlob(id, file);
      const blobUrl = await getImageBlobUrl(id);
      const pos = placeNonOverlapping(nodes, 40, 40, w, h);
      const node = { id: uuid(), type: "image", x: pos.x, y: pos.y, w: pos.w, h: pos.h, imageId: id, imageBlobUrl: blobUrl, selected: false };
      setNodes((prev) => [...prev, node]);
      setStatus("Image added.");
    } catch (err) {
      console.error(err);
      setStatus("Failed to add image.");
    }
  }
  function addTextNode(text = "New note") {
    const content = (text ?? "").toString();
    const pos = placeNonOverlapping(nodes, 60, 60, 220, 120);
    const node = { id: uuid(), type: "text", x: pos.x, y: pos.y, w: pos.w, h: pos.h, text: content, selected: false };
    setNodes((prev) => [...prev, node]);
  }
  function clearSelection() {
    setNodes((prev) => prev.map((n) => ({ ...n, selected: false })));
  }
  function deleteSelected() {
    const toDelete = nodes.filter((n) => n.selected && n.type === "image" && n.imageId).map((n) => n.imageId);
    toDelete.forEach((id) => deleteImage(id));
    setNodes((prev) => prev.filter((n) => !n.selected));
  }
  function clearCanvas() {
    const ids = nodes.filter((n) => n.type === "image" && n.imageId).map((n) => n.imageId);
    ids.forEach((id) => deleteImage(id));
    setNodes([]);
    setStatus("Cleared.");
  }
  async function executeAI() {
    const selected = nodes.filter((n) => n.selected);
    if (selected.length === 0) {
      setStatus("Select nodes first.");
      return;
    }
    let success = false;
    setLoading(true);
    setStatus("Thinking\u2026");
    try {
      const { descriptions } = await describeImagesIfNeeded(selected, freeMode);
      const chosenAspect = aspect;
      const outputs = await generateNodesFromSelection(
        selected.map((n) => ({ ...n })),
        descriptions,
        freeMode,
        chosenAspect,
        modelOptions
      );
      console.log("[executeAI] selected", selected.map((n) => ({ id: n.id, type: n.type, w: n.w, h: n.h })));
      console.log("[executeAI] aspect chosen", chosenAspect);
      console.log("[executeAI] outputs", outputs);
      const baseX = selected.reduce((sum, n) => sum + n.x, 0) / selected.length;
      const baseY = selected.reduce((sum, n) => sum + n.y, 0) / selected.length;
      const newNodes = [];
      for (const out of outputs) {
        let n;
        if (out.type === "text") {
          const pos = placeNonOverlapping([...nodes, ...newNodes], baseX + 40, baseY + 40, out.w, out.h);
          n = { id: uuid(), type: "text", x: pos.x, y: pos.y, w: pos.w, h: pos.h, text: out.text, selected: false };
        } else {
          const imgResp = await fetch(out.url);
          if (!imgResp.ok) {
            throw new Error(`Generated image download failed: ${imgResp.status} ${imgResp.statusText}`);
          }
          const blob = await imgResp.blob();
          if (!blob || blob.size === 0) {
            throw new Error("Generated image was empty.");
          }
          const imgId = uuid();
          await storeImageBlob(imgId, blob);
          const blobUrl = await getImageBlobUrl(imgId);
          const pos = placeNonOverlapping([...nodes, ...newNodes], baseX + 40, baseY + 40, out.w || 256, out.h || 256);
          n = { id: uuid(), type: "image", x: pos.x, y: pos.y, w: pos.w, h: pos.h, imageId: imgId, imageBlobUrl: blobUrl, selected: false };
        }
        newNodes.push(n);
      }
      setNodes((prev) => [...prev, ...newNodes]);
      setStatus("Done.");
      success = true;
    } catch (e) {
      console.error(e);
      setStatus(`Generation failed: ${getGenerationErrorMessage(e)}`);
    } finally {
      setLoading(false);
      setTimeout(() => setStatus(""), success ? 1200 : 6000);
    }
  }
  function onMouseDownCanvas(e) {
    if (spaceDownRef.current) {
      e.preventDefault();
      const startX = e.clientX, startY = e.clientY;
      const startPan = { ...pan };
      setIsPanning(true);
      if (canvasRef.current) canvasRef.current.style.cursor = "grabbing";
      const move2 = (ev) => {
        setPan({ x: startPan.x - (ev.clientX - startX), y: startPan.y - (ev.clientY - startY) });
      };
      const up2 = () => {
        setIsPanning(false);
        if (canvasRef.current) canvasRef.current.style.cursor = spaceDownRef.current ? "grab" : "default";
        window.removeEventListener("mousemove", move2);
        window.removeEventListener("mouseup", up2);
      };
      window.addEventListener("mousemove", move2);
      window.addEventListener("mouseup", up2);
      return;
    }
    if (e.target !== e.currentTarget) return;
    const wp = toWorldPoint(e.clientX, e.clientY);
    let m = {
      x1: wp.x,
      y1: wp.y,
      x2: wp.x,
      y2: wp.y
    };
    setMarquee(m);
    setNodes((prev) => prev.map((n) => ({ ...n, selected: false })));
    const move = (ev) => {
      const wpm = toWorldPoint(ev.clientX, ev.clientY);
      m.x2 = wpm.x;
      m.y2 = wpm.y;
      setMarquee({ ...m });
      setNodes((prev) => prev.map((n) => ({ ...n, selected: withinMarquee(n, m) })));
    };
    const up = () => {
      setMarquee(null);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }
  function startDragNode(n, e) {
    if (spaceDownRef.current) {
      return;
    }
    e.stopPropagation();
    const multi = e.shiftKey || e.metaKey || e.ctrlKey;
    setNodes((prev) => prev.map((m) => {
      if (m.id === n.id) return { ...m, selected: multi ? !m.selected : true };
      return multi ? m : { ...m, selected: false };
    }));
    const startX = e.clientX, startY = e.clientY;
    const initial = { x: n.x, y: n.y };
    dragRef.current = { id: n.id };
    const move = (ev) => {
      const dx = (ev.clientX - startX) / scale;
      const dy = (ev.clientY - startY) / scale;
      setNodes((prev) => prev.map((m) => m.id === n.id ? { ...m, x: initial.x + dx, y: initial.y + dy } : m));
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }
  function startResizeNode(n, e) {
    if (spaceDownRef.current) {
      return;
    }
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const initial = { w: n.w, h: n.h };
    const move = (ev) => {
      const dx = (ev.clientX - startX) / scale;
      const dy = (ev.clientY - startY) / scale;
      setNodes((prev) => prev.map((m) => m.id === n.id ? { ...m, w: Math.max(80, initial.w + dx), h: Math.max(80, initial.h + dy) } : m));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }
  function toggleSelect(n, e) {
    if (spaceDownRef.current) {
      return;
    }
    e.stopPropagation();
    const multi = e.shiftKey || e.metaKey || e.ctrlKey;
    setNodes((prev) => prev.map((m) => {
      if (m.id === n.id) return { ...m, selected: multi ? !m.selected : true };
      return multi ? m : { ...m, selected: false };
    }));
  }
  function updateText(n, val) {
    setNodes((prev) => prev.map((m) => m.id === n.id ? { ...m, text: val } : m));
  }
  return /* @__PURE__ */ jsxDEV("div", { className: "app", children: [
    /* @__PURE__ */ jsxDEV("div", { className: "toolbar", children: [
      /* @__PURE__ */ jsxDEV("button", { type: "button", className: "icon-btn", title: "Add Text", onClick: () => addTextNode("New note"), children: /* @__PURE__ */ jsxDEV("i", { className: "fa-solid fa-font" }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 386,
        columnNumber: 109
      }, this) }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 386,
        columnNumber: 9
      }, this),
      /* @__PURE__ */ jsxDEV("label", { className: "icon-btn", title: "Upload Image", children: [
        /* @__PURE__ */ jsxDEV("i", { className: "fa-regular fa-image" }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 388,
          columnNumber: 11
        }, this),
        /* @__PURE__ */ jsxDEV("input", { type: "file", accept: "image/*", style: { display: "none" }, onChange: (e) => {
          const f = e.target.files?.[0];
          if (f) {
            addImageFile(f);
          }
          e.target.value = "";
        } }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 389,
          columnNumber: 11
        }, this)
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 387,
        columnNumber: 9
      }, this),
      /* @__PURE__ */ jsxDEV("button", { type: "button", className: "icon-btn", title: "Clear Canvas", onClick: clearCanvas, children: /* @__PURE__ */ jsxDEV("i", { className: "fa-solid fa-broom" }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 395,
        columnNumber: 95
      }, this) }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 395,
        columnNumber: 9
      }, this),
      /* @__PURE__ */ jsxDEV("div", { style: { display: "flex", alignItems: "center", gap: 8 }, children: /* @__PURE__ */ jsxDEV(
        "select",
        {
          value: String(Math.round(scale * 100)),
          onChange: (e) => {
            const v = e.target.value;
            if (v === "fit") {
              fitToContent();
            } else {
              const pct = parseInt(v, 10);
              if (!isNaN(pct)) {
                const canvasEl = canvasRef.current;
                const cx = canvasEl ? canvasEl.clientWidth / 2 : 0;
                const cy = canvasEl ? canvasEl.clientHeight / 2 : 0;
                zoomAtScreenPoint(cx, cy, pct / 100);
              }
            }
          },
          style: { border: "1px solid #ddd", padding: "8px", borderRadius: "8px" },
          children: [
            /* @__PURE__ */ jsxDEV("option", { value: String(Math.round(scale * 100)), children: [
              Math.round(scale * 100),
              "%"
            ] }, void 0, true, {
              fileName: "<stdin>",
              lineNumber: 415,
              columnNumber: 13
            }, this),
            /* @__PURE__ */ jsxDEV("option", { value: "50", children: "50%" }, void 0, false, {
              fileName: "<stdin>",
              lineNumber: 416,
              columnNumber: 13
            }, this),
            /* @__PURE__ */ jsxDEV("option", { value: "75", children: "75%" }, void 0, false, {
              fileName: "<stdin>",
              lineNumber: 417,
              columnNumber: 13
            }, this),
            /* @__PURE__ */ jsxDEV("option", { value: "100", children: "100%" }, void 0, false, {
              fileName: "<stdin>",
              lineNumber: 418,
              columnNumber: 13
            }, this),
            /* @__PURE__ */ jsxDEV("option", { value: "150", children: "150%" }, void 0, false, {
              fileName: "<stdin>",
              lineNumber: 419,
              columnNumber: 13
            }, this),
            /* @__PURE__ */ jsxDEV("option", { value: "200", children: "200%" }, void 0, false, {
              fileName: "<stdin>",
              lineNumber: 420,
              columnNumber: 13
            }, this),
            /* @__PURE__ */ jsxDEV("option", { value: "fit", children: "Fit" }, void 0, false, {
              fileName: "<stdin>",
              lineNumber: 421,
              columnNumber: 13
            }, this)
          ]
        },
        void 0,
        true,
        {
          fileName: "<stdin>",
          lineNumber: 397,
          columnNumber: 11
        },
        this
      ) }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 396,
        columnNumber: 9
      }, this),
      /* @__PURE__ */ jsxDEV("div", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [
        /* @__PURE__ */ jsxDEV("i", { className: "fa-solid fa-crop", style: { opacity: 0.8 } }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 425,
          columnNumber: 11
        }, this),
        /* @__PURE__ */ jsxDEV(AspectDropdown, { value: aspect, onChange: setAspect }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 426,
          columnNumber: 11
        }, this)
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 424,
        columnNumber: 9
      }, this),
      /* @__PURE__ */ jsxDEV(ModelSelectCard, { options: visibleModels, loading: modelCatalogLoading, selectedModel, setSelectedModel, showPaidModels, setShowPaidModels }, void 0, false, void 0, this),
      /* @__PURE__ */ jsxDEV(
        "button",
        {
          onClick: () => {
            const hasSelection = nodes.some((n) => n.selected);
            if (!hasSelection) {
              setShowWarn(true);
              return;
            }
            executeAI();
          },
          className: !nodes.some((n) => n.selected) ? "disabled" : "",
          children: [
            /* @__PURE__ */ jsxDEV("i", { className: "fa-solid fa-play", style: { marginRight: 6 } }, void 0, false, {
              fileName: "<stdin>",
              lineNumber: 432,
              columnNumber: 11
            }, this),
            loading ? "Executing\u2026" : "Execute"
          ]
        },
        void 0,
        true,
        {
          fileName: "<stdin>",
          lineNumber: 428,
          columnNumber: 9
        },
        this
      ),
      /* @__PURE__ */ jsxDEV("div", { className: "toggle", title: "Free Mode", style: { marginLeft: "auto" }, children: [
        /* @__PURE__ */ jsxDEV("i", { className: "fa-solid fa-wand-magic-sparkles", style: { opacity: 0.8 } }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 435,
          columnNumber: 11
        }, this),
        /* @__PURE__ */ jsxDEV("span", { style: { marginLeft: 6, marginRight: 6, fontWeight: 600 }, children: "Free Mode" }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 436,
          columnNumber: 11
        }, this),
        /* @__PURE__ */ jsxDEV("input", { id: "free-toggle", type: "checkbox", checked: freeMode, onChange: (e) => setFreeMode(e.target.checked), style: { display: "none" } }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 437,
          columnNumber: 11
        }, this),
        /* @__PURE__ */ jsxDEV("label", { htmlFor: "free-toggle", className: "switch", "aria-label": "Free Mode" }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 438,
          columnNumber: 11
        }, this)
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 434,
        columnNumber: 9
      }, this)
    ] }, void 0, true, {
      fileName: "<stdin>",
      lineNumber: 385,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("div", { className: "canvas", ref: canvasRef, onMouseDown: onMouseDownCanvas, children: [
      /* @__PURE__ */ jsxDEV(
        "div",
        {
          ref: worldRef,
          className: "world",
          onMouseDown: onMouseDownCanvas,
          style: { transform: `translate(${-pan.x}px, ${-pan.y}px) scale(${scale})` },
          children: nodes.map((n) => /* @__PURE__ */ jsxDEV(
            "div",
            {
              className: `node ${n.selected ? "selected" : ""}`,
              style: { left: n.x, top: n.y, width: n.w, height: n.h },
              onMouseDown: (e) => toggleSelect(n, e),
              children: [
                /* @__PURE__ */ jsxDEV("div", { className: "drag", onMouseDown: (e) => startDragNode(n, e), title: "Drag to move" }, void 0, false, {
                  fileName: "<stdin>",
                  lineNumber: 456,
                  columnNumber: 15
                }, this),
                n.type === "text" ? /* @__PURE__ */ jsxDEV("textarea", { value: n.text || "", onChange: (e) => updateText(n, e.target.value) }, void 0, false, {
                  fileName: "<stdin>",
                  lineNumber: 458,
                  columnNumber: 17
                }, this) : n.imageBlobUrl ? /* @__PURE__ */ jsxDEV("img", { src: n.imageBlobUrl, alt: "node", draggable: false }, void 0, false, {
                  fileName: "<stdin>",
                  lineNumber: 460,
                  columnNumber: 34
                }, this) : /* @__PURE__ */ jsxDEV("div", { className: "loading", style: { padding: 12 }, children: "Loading image\u2026" }, void 0, false, {
                  fileName: "<stdin>",
                  lineNumber: 460,
                  columnNumber: 94
                }, this),
                /* @__PURE__ */ jsxDEV("div", { className: "handle", onMouseDown: (e) => startResizeNode(n, e) }, void 0, false, {
                  fileName: "<stdin>",
                  lineNumber: 462,
                  columnNumber: 15
                }, this)
              ]
            },
            n.id,
            true,
            {
              fileName: "<stdin>",
              lineNumber: 450,
              columnNumber: 13
            },
            this
          ))
        },
        void 0,
        false,
        {
          fileName: "<stdin>",
          lineNumber: 443,
          columnNumber: 9
        },
        this
      ),
      marquee && /* @__PURE__ */ jsxDEV("div", { className: "marquee", style: {
        left: Math.min(marquee.x1, marquee.x2) * scale - pan.x,
        top: Math.min(marquee.y1, marquee.y2) * scale - pan.y,
        width: Math.abs(marquee.x2 - marquee.x1) * scale,
        height: Math.abs(marquee.y2 - marquee.y1) * scale
      } }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 467,
        columnNumber: 11
      }, this)
    ] }, void 0, true, {
      fileName: "<stdin>",
      lineNumber: 442,
      columnNumber: 7
    }, this),
    showWarn && /* @__PURE__ */ jsxDEV("div", { className: "modal-backdrop", onClick: () => setShowWarn(false), children: /* @__PURE__ */ jsxDEV("div", { className: "modal", onClick: (e) => e.stopPropagation(), children: [
      /* @__PURE__ */ jsxDEV("h3", { children: "No selection" }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 479,
        columnNumber: 13
      }, this),
      /* @__PURE__ */ jsxDEV("p", { children: "Please select at least one node before executing." }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 480,
        columnNumber: 13
      }, this),
      /* @__PURE__ */ jsxDEV("div", { className: "actions", children: /* @__PURE__ */ jsxDEV("button", { onClick: () => setShowWarn(false), children: "OK" }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 482,
        columnNumber: 15
      }, this) }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 481,
        columnNumber: 13
      }, this)
    ] }, void 0, true, {
      fileName: "<stdin>",
      lineNumber: 478,
      columnNumber: 11
    }, this) }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 477,
      columnNumber: 9
    }, this),
    /* @__PURE__ */ jsxDEV("div", { className: "footer", children: status || "Paste images or text directly. Save is automatic." }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 488,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "<stdin>",
    lineNumber: 384,
    columnNumber: 5
  }, this);
}
function getEffectiveAspectRatio(selected) {
  const supported = ["1:1", "3:4", "4:3", "9:16", "16:9"];
  const img = selected.find((n) => n.type === "image");
  if (!img) return "1:1";
  const r = img.w / img.h;
  const candidates = [
    { ar: "1:1", val: 1 },
    { ar: "3:4", val: 3 / 4 },
    { ar: "4:3", val: 4 / 3 },
    { ar: "9:16", val: 9 / 16 },
    { ar: "16:9", val: 16 / 9 }
  ];
  let best = candidates[0], bestDiff = Math.abs(r - candidates[0].val);
  for (const c of candidates) {
    const d = Math.abs(r - c.val);
    if (d < bestDiff) {
      best = c;
      bestDiff = d;
    }
  }
  return best.ar;
}
function ModelSelectCard({ options, loading, selectedModel, setSelectedModel, showPaidModels, setShowPaidModels }) {
  return /* @__PURE__ */ jsxDEV("div", { className: "model-card", children: [
    /* @__PURE__ */ jsxDEV("div", { className: "model-card-head", children: [
      /* @__PURE__ */ jsxDEV("span", { className: "model-card-label", children: "Model" }, void 0, false, void 0, this),
      /* @__PURE__ */ jsxDEV("label", { className: "model-paid-toggle", children: [
        /* @__PURE__ */ jsxDEV("input", { type: "checkbox", checked: showPaidModels, onChange: (e) => setShowPaidModels(e.target.checked) }, void 0, false, void 0, this),
        /* @__PURE__ */ jsxDEV("span", { children: "Paid" }, void 0, false, void 0, this)
      ] }, void 0, true, void 0, this)
    ] }, void 0, true, void 0, this),
    /* @__PURE__ */ jsxDEV("select", { className: "model-select", value: selectedModel, onChange: (e) => setSelectedModel(e.target.value), children: loading ? /* @__PURE__ */ jsxDEV("option", { value: selectedModel, children: "Loading models..." }, "loading", false, void 0, this) : options.length ? options.map((model) => /* @__PURE__ */ jsxDEV("option", { value: model.value, children: model.label }, model.value, false, void 0, this)) : /* @__PURE__ */ jsxDEV("option", { value: "kontext", children: "kontext (fallback)" }, "fallback", false, void 0, this) }, void 0, false, void 0, this)
  ] }, void 0, true, void 0, this);
}
function AspectDropdown({ value, onChange }) {
  const options = ["1:1", "3:4", "4:3", "9:16", "16:9"];
  return /* @__PURE__ */ jsxDEV(
    "select",
    {
      value,
      onChange: (e) => onChange(e.target.value),
      style: { border: "1px solid #ddd", padding: "8px", borderRadius: "8px" },
      children: options.map((opt) => /* @__PURE__ */ jsxDEV("option", { value: opt, children: opt }, opt, false, {
        fileName: "<stdin>",
        lineNumber: 521,
        columnNumber: 28
      }, this))
    },
    void 0,
    false,
    {
      fileName: "<stdin>",
      lineNumber: 516,
      columnNumber: 5
    },
    this
  );
}
export {
  CanvasApp as default
};
