/**
 * Accent: Pick unused Pantone colors from a reference colors list.
 * Copyright (C) 2017  Dario Castañé
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 *
 * Accent is a tailored tool for a specific end: to find a new accent color for
 * Pirates de Catalunya (Pirate Party of Catalonia).
 * 
 * Although being tailored, I think it is enough generic for your use. Just
 * create a base-colors.json file with an array of hex codes. These are your
 * base colors. Accent will use them to look for unused RGB regions among
 * these base colors.
 *
 * In other words: this tool generates a list of Pantone colors for designers.
 * These generated colors will be as far as it can be from your base colors.
 *
 * The rationale behind this is that in political communication you must stand
 * up among other bigger parties. You need to be unique, even in your color
 * branding.
 *
 * It may look a bit overengineering as it is written. You can just do the same
 * comparing the Pantone full list using their Delta E against the base colors.
 * But it was desired to be able to also generate non Pantone colors (second
 * round results).
 *
 * Consider this to be a less-than-four-days-hackathon quality. It works and it
 * is nice but it can be vastly improved.
 *
 * Enough said, here be dragons.
 */
const DeltaE = require('delta-e');
const Spectra = require('spectra');
const math = require('mathjs');
const Contrast = require('wcag-contrast');
const Optional = require('optional-js');
const fs = require('fs');
const log = require('fancy-log');
const argv = require('yargs').argv

var baseColorsData = {};
baseFile = (argv.file || 'base-colors');
var baseColors = loadColorsFile(baseFile, function(color) {
    baseColorsData[color.hex()] = {};
});

var process = function(metric, measureFn, updateRelatedFn) {
    return function(color) {
        var result = measureFn(color);
        var colorHex = color.hex()
        if (colorHex != '#000000' && colorHex != '#ffffff' && updateRelatedFn) {
            updateRelatedFn(result);
        }
        baseColorsData[color][metric] = result;
        return result;
    };
};

var black = Spectra('#000000');
var blackLab = toLab(black);
var white = Spectra('#ffffff');
var whiteLab = toLab(white);
var refMinBlackDeltaE = 100;
var refMinWhiteDeltaE = 100;
var refMinLuma = 255;
var refMaxLuma = 0;

var refBlackDeltaE = calcMedian(process('blackDeltaE', color => DeltaE.getDeltaE00(toLab(color), blackLab), function(value) {
    if (value < refMinBlackDeltaE) {
        refMinBlackDeltaE = value;
    }
}));
log.info('refMinBlackDeltaE:', refMinBlackDeltaE);

var refWhiteDeltaE = calcMedian(process('whiteDeltaE', color => DeltaE.getDeltaE00(toLab(color), whiteLab), function(value) {
    if (value < refMinWhiteDeltaE) {
        refMinWhiteDeltaE = value;
    }
}));
log.info('refMinWhiteDeltaE:', refMinWhiteDeltaE);

var refDeltaE = math.median(baseColors.map(function(color) {
    return math.median(baseColors.map(baseColor => DeltaE.getDeltaE00(toLab(color), toLab(baseColor))));
}));
log.info('refDeltaE:', refDeltaE);

var refLuma = calcMedian(process('luma', color => color.luma(), function(value) {
    if (value < refMinLuma) {
        refMinLuma = value;
    }
    if (value > refMaxLuma) {
        refMaxLuma = value;
    }
}));
log.info('refMinLuma:', refMinLuma);
log.info('refMaxLuma:', refMaxLuma);

var analyze = function(rgbNumber) {
    var color = Spectra(rgbNumberToHex(rgbNumber));
    var colorLab = toLab(color);
    var colorHex = color.hex();
    var whiteContrast = Contrast.hex(colorHex, '#ffffff');
    if (!between(whiteContrast, 3, 21)) {
        return undefined;
    }
    var blackContrast = Contrast.hex(colorHex, '#000000');
    if (!between(blackContrast, 3, 21)) {
        return undefined;
    }
    var whiteDeltaE = DeltaE.getDeltaE00(colorLab, whiteLab);
    if (!between(whiteDeltaE, refMinWhiteDeltaE, 100)) {
        return undefined;
    }
    var blackDeltaE = DeltaE.getDeltaE00(colorLab, blackLab);
    if (!between(blackDeltaE, refMinBlackDeltaE, 100)) {
        return undefined;
    }
    if (!between(color.luma(), refMinLuma, refMaxLuma)) {
        return undefined;
    }
    return color;
}

hasGoodDeltaAll = function(color, arr, threshold) {
    var colorLab = toLab(color);
    return !arr.some(otherColor => DeltaE.getDeltaE00(colorLab, toLab(otherColor)) < (threshold || refDeltaE));
}

log.info('Starting first round...');
var classified = memoize(baseFile + '-first', runAnalyzer, [baseColors, classified]);
log.info('First round finished.', classified.length, 'selected.');

log.info('Starting second round...');
classified = memoize(baseFile + '-second', runRound, [classified, baseColors, function(source, ref, refDelta, selected) {
    var raw = [];
    for (var i = 0; i < source.length; i++) {
        var color = source[i];
        if (!hasGoodDeltaAll(color, ref, refDelta)) {
            continue;
        }
        raw.push(color);
    }
    consolidate(raw, ref, 49).map(color => selected.push(color));
}]);
log.info('Second round finished.', classified.length, 'selected.');

var pantoneColors = loadColorsFile('pantone-colors');
log.info('Starting third round...');
log.info('Adjusting base delta...');
var refBaseDelta = adjustDelta(classified, baseColors);
log.info('Adjusted base delta:', refBaseDelta);
classified = memoize(baseFile + '-third', runRound, [classified, pantoneColors, function(source, ref, refDelta, selected) {
    var raw = [];
    for (var i = 0; i < ref.length; i++) {
        var refColor = analyze(ref[i].rgbNumber());
        if (refColor == undefined) {
            continue;
        }
        if (!hasGoodDeltaAll(refColor, baseColors, refBaseDelta)) {
            continue;
        }
        if (!hasGoodDeltaAll(refColor, classified, refDelta)) {
            continue;
        }
        raw.push(refColor);
    }
    var tmp = [];
    consolidate(raw, baseColors, 5).map(color => tmp.push(color));
    consolidate(tmp, tmp, 5).map(color => selected.push(color));
}]);
log.info('Third round finished.', classified.length, 'selected.');

for (var i = 0; i < classified.length; i++) {
    printColor(classified[i]);
}

// --- Utils ---

function loadColorsFile(name, callback) {
    var file = JSON.parse(fs.readFileSync('./' + name + '.json', 'utf8')).sort().map(function(e) {
        var color = Spectra(e);
        if (callback) {
            callback(color);
        }
        return color;
    });
    log.info(name + '.json loaded.');
    return file;
}

function calcMedian(processFn) {
    return math.median(baseColors.map(color => processFn(color)));
}

function toLab(color) {
    var result = color.labObject();
    return { L: result['l'], A: result['a'], B: result['b'] };
}

function select(arr) {
    return function(value) {
        arr.push(value);
    };
}

function tooClose(currentRGBNumber, barrierColor) {
    var color = Spectra(rgbNumberToHex(currentRGBNumber));
    var deltaE = DeltaE.getDeltaE00(toLab(color), toLab(barrierColor));
    return deltaE < 2;
}

function between(value, minimum, maximum, ref) {
    var low = minimum;
    var high = maximum;
    if (ref) {
        var refValue = ref['value'];
        var margin = ref['margin'] / 100;
        low = refValue - (refValue * margin);
        if (low < minimum) {
            low = minimum;
        }
        high = refValue + (refValue * margin);
        if (high > maximum) {
            high = maximum;
        }
    }
    return (value > low) && (value < high);
}

function rgbNumberToHex(rgbNumber) {
    var hex = rgbNumber.toString(16);
    while (hex.length < 6) { hex = '0' + hex; }
    return '#' + hex;
}

function memoize(id, callback, args) {
    var result = [];
    var cachePath = './cache-' + id + '.json';
    if (fs.existsSync(cachePath)) {
        var loaded = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        for (var i = 0; i < loaded.length; i++) {
            result.push(Spectra(loaded[i]['color']));
        }
        log.info('Results loaded from cache:', cachePath);
        return result;
    }
    result = callback.apply(null, args);
    fs.writeFileSync(cachePath, JSON.stringify(result));
    return result;
}

function runAnalyzer(baseColors) {
    var colors = baseColors.slice(0);
    if (colors.length > 0) {
        if (colors[0].hex() != '#000000') {
            colors.unshift(black);
        }
        if (colors[colors.length - 1].hex() != '#ffffff') {
            colors.push(white);
        }
    }
    var classified = [];
    for (var i = 0; i < colors.length; i++) {
        var start = colors[i];
        var end = colors[i + 1];
        if (end === undefined) {
            break;
        }
        var samples = Math.round((end.rgbNumber() - start.rgbNumber()) / 2);
        var middle = start.rgbNumber() + samples;
        Optional.ofNullable(analyze(middle)).ifPresent(select(classified));
        for (var j = 1; j < samples; j++) {
            if (tooClose(middle - j, start)) {
                break;
            }
            Optional.ofNullable(analyze(middle + j)).ifPresent(select(classified));
            Optional.ofNullable(analyze(middle - j)).ifPresent(select(classified));
        }
    }
    return classified;
}

function adjustDelta(source, ref) {
    return math.median(source.map(function(color) {
        var colorLab = toLab(color);
        return math.min(ref.map(refColor => DeltaE.getDeltaE00(colorLab, toLab(refColor))));
    }));
}

function runRound(source, ref, callback) {
    var selected = [];
    log.info('Adjusting delta...');
    var refDelta = adjustDelta(source, ref);
    log.info('Adjusted delta:', refDelta);
    callback(source, ref, refDelta, selected);
    return selected;
}

function consolidate(arr, ref, refDelta) {
    var group = [];
    var groups = [];
    log.info('Grouping colors to consolidate...');
    arr = arr.sort();
    for (var i = 0; i < arr.length; i += 2) {
        var color = arr[i];
        group.push(color);
        if (arr[i + 1] == undefined) {
            break;
        }
        var nextColor = arr[i + 1];
        var delta = DeltaE.getDeltaE00(toLab(color), toLab(nextColor));
        if (delta > refDelta) {
            groups.push(group);
            group = [];
        }
        group.push(nextColor);
    }
    var classified = [];
    log.info('Consolidating...');
    for (var i = 0; i < groups.length; i++) {
        var deltas = [];
        var group = groups[i];
        for (var j = 0; j < group.length; j++) {
            var color = group[j];
            var colorLab = toLab(color);
            deltas.push(math.median(ref.map(c => DeltaE.getDeltaE00(colorLab, toLab(c)))));
        }
        var max = math.max(deltas);
        classified.push(group[deltas.indexOf(max)]);
    }
    log.info('Consolidation done.');
    return classified;
}

function printColor(color) {
    var rgbURL = 'http://rgb.to/' + rgbNumberToHex(color.rgbNumber()).replace('#', '');
    var details = {
        hex: color.hex(),
        url: rgbURL,
        luma: color.luma(),
    }
    log.info('Selected color: '+ JSON.stringify(details));
}

