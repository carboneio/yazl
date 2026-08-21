// Measures what this fork's optimizations are worth: the crc32 computed by zlib instead of
// buffer-crc32, and large buffers deflated in several pieces at once instead of one go.
//
// The "before" numbers come from this very same index.js with both optimizations turned
// off, so the two yazl runs differ by nothing else. archiver is timed on the same files
// at the same compression level (6), also entirely in memory.
//
// Run with: npm run benchmark [-- ITERATIONS]

var fs = require("fs");
var os = require("os");
var path = require("path");
var Writable = require("stream").Writable;
var ZipArchive = require("archiver").ZipArchive;

var ITERATIONS = Number(process.argv[2]) || 5;

var CASES = [
  {payload: "100 KB", fileCount: 1,  totalSize: 100 * 1024},
  {payload: "1 MB",   fileCount: 10, totalSize: 1024 * 1024},
  {payload: "10 MB",  fileCount: 1,  totalSize: 10 * 1024 * 1024},
  {payload: "100 MB", fileCount: 1,  totalSize: 100 * 1024 * 1024},
];

var after = require("../");
var before = loadYazlWithoutOptimizations();

var rows = [];
runCase(0);

function runCase(caseIndex) {
  if (caseIndex === CASES.length) return report();
  var testCase = CASES[caseIndex];
  var files = splitIntoFiles(makeXmlishBuffer(testCase.totalSize), testCase.fileCount);

  timeZipping(function(cb) { zipOnceYazl(before, files, cb); }, function(beforeMs, beforeSize) {
    timeZipping(function(cb) { zipOnceYazl(after, files, cb); }, function(afterMs, afterSize) {
      timeZipping(function(cb) { zipOnceArchiver(files, cb); }, function(archiverMs, archiverSize) {
        rows.push({
          payload: testCase.payload,
          fileCount: testCase.fileCount,
          beforeMs: beforeMs,
          afterMs: afterMs,
          archiverMs: archiverMs,
          beforeSize: beforeSize,
          afterSize: afterSize,
          archiverSize: archiverSize,
        });
        console.error(
          testCase.payload + ": yazl " + beforeMs.toFixed(1) + " ms -> " + afterMs.toFixed(1) +
          " ms, archiver " + archiverMs.toFixed(1) + " ms"
        );
        runCase(caseIndex + 1);
      });
    });
  });
}

// Zips the files ITERATIONS times, plus one warmup round that is thrown away,
// and reports the median duration.
function timeZipping(zipOnce, callback) {
  var durations = [];
  var archiveSize = 0;
  zipOnce(function() {
    next();
  });
  function next() {
    if (durations.length === ITERATIONS) return callback(median(durations), archiveSize);
    zipOnce(function(duration, byteCount) {
      durations.push(duration);
      archiveSize = byteCount;
      // Let the event loop breathe so the previous run is fully torn down.
      setImmediate(next);
    });
  }
}

// Builds a whole archive in memory, from the first addBuffer() to the last byte
// of the output stream. Nothing is written to disk, so this measures cpu only.
function zipOnceYazl(yazl, files, callback) {
  var startedAt = performance.now();
  var zipfile = new yazl.ZipFile();
  zipfile.on("error", function(err) {
    throw err;
  });
  zipfile.outputStream.pipe(countingSink(startedAt, callback));
  for (var i = 0; i < files.length; i++) {
    zipfile.addBuffer(files[i], "file" + i + ".xml");
  }
  zipfile.end();
}

function zipOnceArchiver(files, callback) {
  var startedAt = performance.now();
  // Same default compression level as yazl (6).
  var archive = new ZipArchive({zlib: {level: 6}});
  archive.on("error", function(err) {
    throw err;
  });
  archive.pipe(countingSink(startedAt, callback));
  for (var i = 0; i < files.length; i++) {
    archive.append(files[i], {name: "file" + i + ".xml"});
  }
  archive.finalize();
}

function countingSink(startedAt, callback) {
  var byteCount = 0;
  return new Writable({
    write: function(chunk, encoding, cb) {
      byteCount += chunk.length;
      cb();
    },
  }).on("finish", function() {
    callback(performance.now() - startedAt, byteCount);
  });
}

function report() {
  console.error("");
  console.log("| Payload | Files | yazl before | yazl after | archiver | vs before | vs archiver | Archive size |");
  console.log("| ------- | ----- | ----------- | ---------- | -------- | --------- | ----------- | ------------ |");
  rows.forEach(function(row) {
    console.log(
      "| " + row.payload +
      " | " + row.fileCount +
      " | " + row.beforeMs.toFixed(1) + " ms" +
      " | " + row.afterMs.toFixed(1) + " ms" +
      " | " + row.archiverMs.toFixed(1) + " ms" +
      " | " + (row.beforeMs / row.afterMs).toFixed(1) + "x" +
      " | " + (row.archiverMs / row.afterMs).toFixed(1) + "x" +
      " | " + formatGrowth(row.beforeSize, row.afterSize) +
      " |"
    );
  });
  console.log("");
  console.log(
    "Median of " + ITERATIONS + " runs on Node " + process.version + ", " +
    describeCpu() + ", " +
    "libuv threadpool of " + (process.env.UV_THREADPOOL_SIZE || 4) + "."
  );
  console.log(
    "archiver " + archiverVersion() +
    " at zlib level 6, the same default yazl uses. Archive size is yazl after vs yazl before."
  );
}

// Reloads index.js with both optimizations disabled: no zlib.crc32, and never more than one
// deflate piece. Everything else is the code being measured.
function loadYazlWithoutOptimizations() {
  var source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf-8");
  source = replaceOnce(source, 'typeof zlib.crc32 === "function"', "false");
  source = replaceOnce(source, "var MAX_DEFLATE_PIECES = 4;", "var MAX_DEFLATE_PIECES = 1;");
  // Written next to index.js so that require() resolves buffer-crc32 the same way.
  var unoptimizedPath = path.join(__dirname, "yazl-without-optimizations." + process.pid + ".tmp.js");
  fs.writeFileSync(unoptimizedPath, source);
  try {
    return require(unoptimizedPath);
  } finally {
    fs.unlinkSync(unoptimizedPath);
  }
}

function replaceOnce(source, find, replacement) {
  var index = source.indexOf(find);
  if (index === -1) throw new Error("index.js no longer contains " + JSON.stringify(find) + ". This benchmark needs updating.");
  if (source.indexOf(find, index + find.length) !== -1) throw new Error("index.js contains " + JSON.stringify(find) + " more than once. This benchmark needs updating.");
  return source.slice(0, index) + replacement + source.slice(index + find.length);
}

// Compressible but not repetitive ascii content, in the spirit of the xml
// found in an office document.
function makeXmlishBuffer(byteLength) {
  var lines = [];
  var totalLength = 0;
  for (var i = 0; totalLength < byteLength; i++) {
    var line = '<row id="' + i + '"><cell>value ' + (i % 97) + "</cell><cell>" + ((i * 7919) % 1000003) + "</cell></row>\n";
    lines.push(line);
    totalLength += line.length;
  }
  return Buffer.from(lines.join(""), "utf-8");
}

function splitIntoFiles(buffer, fileCount) {
  var fileSize = Math.ceil(buffer.length / fileCount);
  var files = [];
  for (var start = 0; start < buffer.length; start += fileSize) {
    files.push(buffer.subarray(start, Math.min(start + fileSize, buffer.length)));
  }
  return files;
}

function median(numbers) {
  var sorted = numbers.slice().sort(function(a, b) {
    return a - b;
  });
  var middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function archiverVersion() {
  var dir = path.dirname(require.resolve("archiver"));
  return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")).version;
}

function describeCpu() {
  // os.cpus() answers an empty array when the platform withholds the information.
  var cpus = os.cpus();
  if (cpus.length === 0) return os.arch();
  return cpus.length + " cores (" + cpus[0].model + ")";
}

function formatGrowth(beforeSize, afterSize) {
  var growth = (afterSize / beforeSize - 1) * 100;
  return (growth === 0 ? "+0" : "+" + growth.toFixed(3)) + "%";
}
