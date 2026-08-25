// hostscript.jsx — runs inside After Effects' ExtendScript engine.
// Entry points, called via CSInterface.evalScript from the panel:
//   getSelectedLayerInfo()               -> JSON string describing the selection
//   applySilenceRemoval(segmentsJson, i)  -> performs the ripple/trim edit
//   stackSelectedLayers()                 -> closes gaps between selected layers

// --- minimal JSON polyfill (some older ExtendScript engines lack native JSON) ---
if (typeof JSON === "undefined") {
    JSON = {};
}
if (!JSON.stringify) {
    JSON.stringify = function (obj) {
        var t = typeof obj;
        if (t !== "object" || obj === null) {
            if (t === "string") return '"' + obj.replace(/"/g, '\\"') + '"';
            return String(obj);
        }
        var isArray = obj instanceof Array;
        var pieces = [];
        if (isArray) {
            for (var i = 0; i < obj.length; i++) pieces.push(JSON.stringify(obj[i]));
            return "[" + pieces.join(",") + "]";
        } else {
            for (var k in obj) {
                if (obj.hasOwnProperty(k)) pieces.push('"' + k + '":' + JSON.stringify(obj[k]));
            }
            return "{" + pieces.join(",") + "}";
        }
    };
}
if (!JSON.parse) {
    JSON.parse = function (str) {
        // eslint-disable-next-line no-eval
        return eval("(" + str + ")");
    };
}

function _errorResult(msg) {
    return JSON.stringify({ ok: false, error: msg });
}

// Returns info about the currently selected layer in the active comp:
// its source media file path, the comp's frame rate, the layer's visible
// source-time range (so the panel can clip VAD segments to what's actually
// trimmed in), and identifying info to pass back into applySilenceRemoval.
function getSelectedLayerInfo() {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return _errorResult("Select a composition and a layer first.");
        }
        var sel = comp.selectedLayers;
        if (!sel || sel.length === 0) {
            return _errorResult("No layer selected. Select the footage layer to process.");
        }
        var layer = sel[0];
        if (!(layer instanceof AVLayer) || !layer.source) {
            return _errorResult("Selected layer has no source media (must be a footage layer).");
        }
        var source = layer.source;
        if (!(source instanceof FootageItem) || !source.file) {
            return _errorResult("Selected layer's source isn't a file on disk (e.g. it's a nested comp). Pre-render it first.");
        }

        var visSourceStart = layer.inPoint - layer.startTime;
        var visSourceEnd = layer.outPoint - layer.startTime;

        return JSON.stringify({
            ok: true,
            filePath: source.file.fsName,
            compName: comp.name,
            compFrameRate: comp.frameRate,
            layerIndex: layer.index,
            layerName: layer.name,
            layerStartTime: layer.startTime,
            visSourceStart: visSourceStart,
            visSourceEnd: visSourceEnd
        });
    } catch (e) {
        return _errorResult("getSelectedLayerInfo error: " + e.toString());
    }
}

// segmentsJson: JSON array of {start, end} in SOURCE-file seconds (0 = start of media file).
// layerIndex: the layer's index at the time getSelectedLayerInfo() was called.
// combine: if true, precompose all the resulting sub-clips into a single layer
// afterward (so the timeline shows one clip instead of one per speech segment).
function applySilenceRemoval(segmentsJson, layerIndex, combine) {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return _errorResult("No active composition.");
        }
        var origLayer = comp.layer(layerIndex);
        if (!origLayer || !(origLayer instanceof AVLayer)) {
            return _errorResult("Original layer not found (index " + layerIndex + "). Did the timeline change?");
        }

        var segments = JSON.parse(segmentsJson);
        if (!segments || segments.length === 0) {
            return _errorResult("No speech segments to keep — nothing to do.");
        }

        // Clip segments to the layer's currently visible source range, in case
        // the layer was already trimmed before running this.
        var visStart = origLayer.inPoint - origLayer.startTime;
        var visEnd = origLayer.outPoint - origLayer.startTime;
        var clipped = [];
        for (var i = 0; i < segments.length; i++) {
            var s = Math.max(segments[i].start, visStart);
            var e = Math.min(segments[i].end, visEnd);
            if (e - s > 0.01) clipped.push({ start: s, end: e });
        }
        if (clipped.length === 0) {
            return _errorResult("None of the detected speech falls within this layer's trimmed range.");
        }

        app.beginUndoGroup("Silence Cutter: Remove Silence");

        var origStartTime = origLayer.startTime;
        var origName = origLayer.name;
        var newLayers = [];
        var cursor = clipped[0].start + origStartTime;

        for (var j = 0; j < clipped.length; j++) {
            var seg = clipped[j];
            var dur = seg.end - seg.start;
            var dup = origLayer.duplicate();

            var newStartTime = cursor - seg.start;
            var newIn = cursor;
            var newOut = cursor + dur;

            // Set startTime first (independent of inPoint/outPoint validity).
            dup.startTime = newStartTime;
            // Defensive ordering so we never momentarily set inPoint > outPoint.
            if (newIn < dup.outPoint) {
                dup.inPoint = newIn;
                dup.outPoint = newOut;
            } else {
                dup.outPoint = newOut;
                dup.inPoint = newIn;
            }
            dup.name = origName + " [" + (j + 1) + "/" + clipped.length + "]";
            newLayers.push(dup);

            cursor += dur;
        }

        // Remove the original layer (duplicates were inserted above it, so it's
        // now the bottom-most of the set).
        origLayer.remove();

        var combinedName = null;
        var combineWarning = null;
        if (combine) {
            try {
                var indices = [];
                for (var k = 0; k < newLayers.length; k++) {
                    indices.push(newLayers[k].index);
                }
                // Sort descending — precomposing is safest when working from the
                // bottom of the layer stack up, per community-documented behavior.
                indices.sort(function (a, b) { return b - a; });

                var newCompName = origName + " (silence removed)";
                var newComp = comp.layers.precompose(indices, newCompName, true);

                // Find the single new layer precompose() inserted into the
                // original comp (the one whose source is the new nested comp).
                var resultLayer = null;
                for (var m = 1; m <= comp.numLayers; m++) {
                    var lyr = comp.layer(m);
                    if (lyr instanceof AVLayer && lyr.source === newComp) {
                        resultLayer = lyr;
                        break;
                    }
                }
                if (resultLayer) {
                    // precompose() doesn't trim anything — the new nested comp
                    // defaults to the original comp's full duration, and the new
                    // layer spans that whole thing. Trim both down to the actual
                    // kept content span.
                    var layerStart = clipped[0].start + origStartTime;
                    var totalDur = cursor - layerStart;
                    resultLayer.startTime = 0; // identity mapping: nested-comp time == parent-comp time
                    if (layerStart < resultLayer.outPoint) {
                        resultLayer.inPoint = layerStart;
                        resultLayer.outPoint = layerStart + totalDur;
                    } else {
                        resultLayer.outPoint = layerStart + totalDur;
                        resultLayer.inPoint = layerStart;
                    }
                    resultLayer.name = newCompName;
                    try {
                        newComp.duration = totalDur;
                        newComp.workAreaStart = 0;
                        newComp.workAreaDuration = totalDur;
                    } catch (eDur) {
                        // non-fatal — comp duration trim failing doesn't affect correctness
                    }
                    combinedName = newCompName;
                } else {
                    combineWarning = "Precomposed, but couldn't locate the resulting layer to trim it — check the timeline.";
                }
            } catch (eCombine) {
                combineWarning = "Silence was removed, but combining into one layer failed: " + eCombine.toString();
            }
        }

        app.endUndoGroup();

        var totalKept = cursor - (clipped[0].start + origStartTime);
        return JSON.stringify({
            ok: true,
            segmentsApplied: clipped.length,
            newDuration: totalKept,
            combined: combinedName,
            combineWarning: combineWarning
        });
    } catch (e) {
        try { app.endUndoGroup(); } catch (e2) {}
        return _errorResult("applySilenceRemoval error: " + e.toString());
    }
}

// Takes all currently-selected layers in the active comp and ripples them
// together with no gaps, in chronological order (by current inPoint) —
// regardless of the order they were selected in. Independent of the
// Analyze/Apply silence-removal flow: works on any layers, however they
// got their current in/out points.
function stackSelectedLayers() {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return _errorResult("No active composition.");
        }
        var sel = comp.selectedLayers;
        if (!sel || sel.length < 2) {
            return _errorResult("Select 2 or more layers to stack together.");
        }

        var layers = [];
        for (var i = 0; i < sel.length; i++) layers.push(sel[i]);

        // sort by current inPoint ascending (selection order doesn't matter)
        layers.sort(function (a, b) { return a.inPoint - b.inPoint; });

        app.beginUndoGroup("Silence Cutter: Stack Layers (No Gap)");

        var startPos = layers[0].inPoint;
        var cursor = startPos;

        for (var j = 0; j < layers.length; j++) {
            var layer = layers[j];
            var dur = layer.outPoint - layer.inPoint;
            var shift = layer.inPoint - cursor;

            layer.startTime = layer.startTime - shift;

            var newIn = layer.inPoint - shift;
            var newOut = layer.outPoint - shift;
            // defensive ordering so we never momentarily set inPoint > outPoint
            if (newIn < layer.outPoint) {
                layer.inPoint = newIn;
                layer.outPoint = newOut;
            } else {
                layer.outPoint = newOut;
                layer.inPoint = newIn;
            }

            cursor += dur;
        }

        app.endUndoGroup();

        return JSON.stringify({
            ok: true,
            layersStacked: layers.length,
            totalSpan: cursor - startPos
        });
    } catch (e) {
        try { app.endUndoGroup(); } catch (e2) {}
        return _errorResult("stackSelectedLayers error: " + e.toString());
    }
}
