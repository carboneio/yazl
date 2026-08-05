var fs = require("fs");
var zlib = require("zlib");
var crc32 = require("buffer-crc32");
var yazl = require("../");
var yauzl = require("yauzl");
var BufferList = require("./bl-minimal.js");

// Test:
//  * filename canonicalization.
//  * addFile, addReadStream, and addBuffer
//  * extracting the zip file (via yauzl) gives the correct contents.
//  * compress: false
//  * specifying mode and mtime options, but not checking them.
//  * verifying compression method defaults to true.
(function() {
  var fileMetadata = {
    mtime: new Date(),
    mode: 0o100664,
  };
  var zipfile = new yazl.ZipFile();
  zipfile.addFile(__filename, "unicōde.txt");
  zipfile.addFile(__filename, "without-compression.txt", {compress: false});
  zipfile.addReadStream(fs.createReadStream(__filename), "readStream.txt", fileMetadata);
  var expectedContents = fs.readFileSync(__filename);
  zipfile.addBuffer(expectedContents, "with/directories.txt", fileMetadata);
  zipfile.addBuffer(expectedContents, "with\\windows-paths.txt", fileMetadata);
  zipfile.end(function(calculatedTotalSize) {
    if (calculatedTotalSize !== -1) throw new Error("calculatedTotalSize is impossible to know before compression");
    zipfile.outputStream.pipe(new BufferList(function(err, data) {
      if (err) throw err;
      yauzl.fromBuffer(data, function(err, zipfile) {
        if (err) throw err;
        zipfile.on("entry", function(entry) {
          var expectedCompressionMethod = entry.fileName === "without-compression.txt" ? 0 : 8;
          if (entry.compressionMethod !== expectedCompressionMethod) throw new Error("expected " + entry.fileName + " compression method " + expectedCompressionMethod + ". found: " + entry.compressionMethod);
          zipfile.openReadStream(entry, function(err, readStream) {
            if (err) throw err;
            readStream.pipe(new BufferList(function(err, data) {
              if (err) throw err;
              if (!expectedContents.equals(data)) throw new Error("unexpected contents");
              console.log(entry.fileName + ": pass");
            }));
          });
        });
      });
    }));
  });
})();

// Test:
//  * specifying compressionLevel varies the output size.
//  * specifying compressionLevel:0 disables compression.
(function() {
  var options = {
    mtime: new Date(),
    mode: 0o100664,
  };
  var zipfile = new yazl.ZipFile();
  options.compressionLevel = 1;
  zipfile.addFile(__filename, "level1.txt", options);
  options.compressionLevel = 9;
  zipfile.addFile(__filename, "level9.txt", options);
  options.compressionLevel = 0;
  zipfile.addFile(__filename, "level0.txt", options);
  zipfile.end(function(calculatedTotalSize) {
    if (calculatedTotalSize !== -1) throw new Error("calculatedTotalSize is impossible to know before compression");
    zipfile.outputStream.pipe(new BufferList(function(err, data) {
      if (err) throw err;
      yauzl.fromBuffer(data, function(err, zipfile) {
        if (err) throw err;

        var fileNameToSize = {};
        zipfile.on("entry", function(entry) {
          fileNameToSize[entry.fileName] = entry.compressedSize;
          var expectedCompressionMethod = entry.fileName === "level0.txt" ? 0 : 8;
          if (entry.compressionMethod !== expectedCompressionMethod) throw new Error("expected " + entry.fileName + " compression method " + expectedCompressionMethod + ". found: " + entry.compressionMethod);
        });
        zipfile.on("end", function() {
          var size0 = fileNameToSize["level0.txt"];
          var size1 = fileNameToSize["level1.txt"];
          var size9 = fileNameToSize["level9.txt"];
          // Note: undefined coerces to NaN which always results in the comparison evaluating to `false`.
          if (!(size0 >= size1)) throw new Error("Compression level 1 inflated size. expected: " + size0 + " >= " + size1);
          if (!(size1 >= size9)) throw new Error("Compression level 9 inflated size. expected: " + size1 + " >= " + size9);
          console.log("compressionLevel (" + size0 + " >= " + size1 + " >= " + size9 + "): pass");
        });
      });
    }));
  });
})();

// Test:
//  * specifying mtime outside the bounds of dos format but in bounds for unix format.
//  * forceDosTimestamp, and verifying the lower clamping for dos format.
//  * specifying mtime after 2038, and verifying the clamping for unix format.
(function() {
  var options = {
    mtime: new Date(0), // unix epoch
    mode: 0o100664,
    compress: false,
  };
  var zipfile = new yazl.ZipFile();
  zipfile.addFile(__filename, "modern-1970.txt", options);
  options.forceDosTimestamp = true;
  zipfile.addFile(__filename, "dos-1970.txt", options);
  options.forceDosTimestamp = false;
  options.mtime = new Date(2080, 1, 1); // year 2080 is beyond the unix range.
  zipfile.addFile(__filename, "2080.txt", options);
  zipfile.end(function(calculatedTotalSize) {
    if (calculatedTotalSize === -1) throw new Error("calculatedTotalSize should be known");
    zipfile.outputStream.pipe(new BufferList(function(err, data) {
      if (err) throw err;
      if (data.length !== calculatedTotalSize) throw new Error("calculatedTotalSize prediction is wrong. " + calculatedTotalSize + " !== " + data.length);
      yauzl.fromBuffer(data, function(err, zipfile) {
        if (err) throw err;
        zipfile.on("entry", function(entry) {
          switch (entry.fileName) {
            case "modern-1970.txt":
              if (entry.getLastModDate().getTime() !== 0) throw new Error("expected unix epoch to be encodable. found: " + entry.getLastModDate());
              break;
            case "dos-1970.txt":
              var year = entry.getLastModDate().getFullYear();
              if (!(1979 <= year && year <= 1981)) throw new Error("expected dos format year to be clamped to 1980ish. found: " + entry.getLastModDate());
              break;
            case "2080.txt":
              if (entry.getLastModDate().getUTCFullYear() !== 2038) throw new Error("expected timestamp clamped down to year 2038. found: " + entry.getLastModDate());
              break;
            default: throw new Error(entry.fileName);
          }
        });
        zipfile.on("end", function() {
          console.log("timestamp encodings: pass");
        });
      });
    }));
  });
})();

// Test:
//  * forceZip64Format for various subsets of entries.
//  * specifying size for addReadStream.
//  * calculatedTotalSize should always be known.
//  * calculatedTotalSize is correct.
(function() {
  var zip64Combinations = [
    [0, 0, 0, 0, 0],
    [1, 1, 0, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 0, 1, 0],
    [0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1],
  ];
  zip64Combinations.forEach(function(zip64Config) {
    var options = {
      compress: false,
      size: null,
      forceZip64Format: false,
    };
    var zipfile = new yazl.ZipFile();
    options.forceZip64Format = !!zip64Config[0];
    zipfile.addFile(__filename, "asdf.txt", options);
    options.forceZip64Format = !!zip64Config[1];
    zipfile.addFile(__filename, "fdsa.txt", options);
    options.forceZip64Format = !!zip64Config[2];
    zipfile.addBuffer(bufferFrom("buffer"), "buffer.txt", options);
    options.forceZip64Format = !!zip64Config[3];

    var someBuffer = bufferFrom("stream");
    options.size = someBuffer.length;
    zipfile.addReadStream(new BufferList().append(someBuffer), "stream.txt", options);
    options.size = null;

    zipfile.end({forceZip64Format:!!zip64Config[4]}, function(calculatedTotalSize) {
      if (calculatedTotalSize === -1) throw new Error("calculatedTotalSize should be known");
      zipfile.outputStream.pipe(new BufferList(function(err, data) {
        if (data.length !== calculatedTotalSize) throw new Error("calculatedTotalSize prediction is wrong. " + calculatedTotalSize + " !== " + data.length);
        console.log("calculatedTotalSize(" + zip64Config.join("") + "): pass");
      }));
    });
  });
})();

// Test adding empty directories and verifying their names in the resulting zipfile.
(function() {
  var zipfile = new yazl.ZipFile();
  zipfile.addFile(__filename, "a.txt");
  zipfile.addBuffer(bufferFrom("buffer"), "b.txt");
  zipfile.addReadStream(new BufferList().append(bufferFrom("stream")), "c.txt");
  zipfile.addEmptyDirectory("d/");
  zipfile.addEmptyDirectory("e");
  zipfile.end(function(calculatedTotalSize) {
    if (calculatedTotalSize !== -1) throw new Error("calculatedTotalSize should be unknown");
    zipfile.outputStream.pipe(new BufferList(function(err, data) {
      if (err) throw err;
      yauzl.fromBuffer(data, function(err, zipfile) {
        if (err) throw err;
        var entryNames = ["a.txt", "b.txt", "c.txt", "d/", "e/"];
        zipfile.on("entry", function(entry) {
          var expectedName = entryNames.shift();
          if (entry.fileName !== expectedName) {
            throw new Error("unexpected entry fileName: " + entry.fileName + ", expected: " + expectedName);
          }
        });
        zipfile.on("end", function() {
          if (entryNames.length === 0) console.log("optional parameters and directories: pass");
        });
      });
    }));
  });
})();

// Test:
//  * just calling addBuffer() and no other add functions.
//  * calculatedTotalSize should be known and correct for addBuffer with compress:false.
//  * addBuffer with compress:false disables compression.
(function() {
  var zipfile = new yazl.ZipFile();
  zipfile.addBuffer(bufferFrom("hello"), "hello.txt", {compress: false});
  zipfile.end(function(calculatedTotalSize) {
    if (calculatedTotalSize === -1) throw new Error("calculatedTotalSize should be known");
    zipfile.outputStream.pipe(new BufferList(function(err, data) {
      if (err) throw err;
      if (data.length !== calculatedTotalSize) throw new Error("calculatedTotalSize prediction is wrong. " + calculatedTotalSize + " !== " + data.length);
      yauzl.fromBuffer(data, function(err, zipfile) {
        if (err) throw err;
        var entryNames = ["hello.txt"];
        zipfile.on("entry", function(entry) {
          var expectedName = entryNames.shift();
          if (entry.fileName !== expectedName) {
            throw new Error("unexpected entry fileName: " + entry.fileName + ", expected: " + expectedName);
          }
          var expectedCompressionMethod = 0;
          if (entry.compressionMethod !== expectedCompressionMethod) throw new Error("expected " + entry.fileName + " compression method " + expectedCompressionMethod + ". found: " + entry.compressionMethod);
        });
        zipfile.on("end", function() {
          if (entryNames.length === 0) console.log("justAddBuffer: pass");
        });
      });
    }));
  });
})();

// Test:
//  * zipfile with no entries.
//  * comment can be string or Buffer.
//  * archive comment uses CP437 encoding for non-ASCII strings. (or rather that yazl and yauzl agree on the encoding.)
var weirdChars = '\u0000☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼⌂ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
(function() {
  var testCases = [
    ["Hello World", "Hello World"],
    [bufferFrom("Hello"), "Hello"],
    [weirdChars, weirdChars],
  ];
  testCases.forEach(function(testCase, i) {
    var zipfile = new yazl.ZipFile();
    zipfile.end({
      comment: testCase[0],
    }, function(calculatedTotalSize) {
      if (calculatedTotalSize === -1) throw new Error("calculatedTotalSize should be known");
      zipfile.outputStream.pipe(new BufferList(function(err, data) {
        if (err) throw err;
        if (data.length !== calculatedTotalSize) throw new Error("calculatedTotalSize prediction is wrong. " + calculatedTotalSize + " !== " + data.length);
        yauzl.fromBuffer(data, function(err, zipfile) {
          if (err) throw err;
          if (zipfile.comment !== testCase[1]) {
            throw new Error("comment is wrong. " + JSON.stringify(zipfile.comment) + " !== " + JSON.stringify(testCase[1]));
          }
          console.log("comment(" + i + "): pass");
        });
      }));
    });
  });
})();

// Test ensuring that archive comment cannot create an ambiguous zip file.
(function() {
  var zipfile = new yazl.ZipFile();
  try {
    zipfile.end({
      comment: bufferFrom("01234567890123456789" + "\x50\x4b\x05\x06" + "01234567890123456789")
    });
  } catch (e) {
    if (e.toString().indexOf("comment contains end of central directory record signature") !== -1) {
      console.log("block eocdr signature in comment: pass");
      return;
    }
  }
  throw new Error("expected error for including eocdr signature in comment");
})();

// Test:
//  * specifying fileComment via addBuffer.
//  * fileComment can be string or Buffer.
//  * yauzl and yazl agree on the encoding.
//  * calculatedTotalSize is known and correct with compress:false.
(function() {
  var testCases = [
    ["Hello World!", "Hello World!"],
    [bufferFrom("Hello!"), "Hello!"],
    [weirdChars, weirdChars],
  ];
  testCases.forEach(function(testCase, i) {
    var zipfile = new yazl.ZipFile();
    zipfile.addBuffer(bufferFrom("hello"), "hello.txt", {compress: false, fileComment: testCase[0]});
    zipfile.end(function(calculatedTotalSize) {
      if (calculatedTotalSize === -1) throw new Error("calculatedTotalSize should be known");
      zipfile.outputStream.pipe(new BufferList(function(err, data) {
        if (err) throw err;
        if (data.length !== calculatedTotalSize) throw new Error("calculatedTotalSize prediction is wrong. " + calculatedTotalSize + " !== " + data.length);
        yauzl.fromBuffer(data, function(err, zipfile) {
          if (err) throw err;
          var entryNames = ["hello.txt"];
          zipfile.on("entry", function(entry) {
            var expectedName = entryNames.shift();
            if (entry.fileComment !== testCase[1]) {
              throw new Error("fileComment is wrong. " + JSON.stringify(entry.fileComment) + " !== " + JSON.stringify(testCase[1]));
            }
          });
          zipfile.on("end", function() {
            if (entryNames.length === 0) console.log("fileComment(" + i + "): pass");
          });
        });
      }));
    });
  });
})();

// Test:
//  * giving an error to the addReadStreamLazy callback emits the error on the zipfile.
//  * calling addReadStreamLazy with no options argument.
//  * trying to add beyond end() throws an error.
(function() {
  var zipfile = new yazl.ZipFile();
  zipfile.on("error", function(err) {
    if (err.message !== "error 1") throw new Error("expected only error 1, got: " + err.message);
  });
  zipfile.addReadStreamLazy("hello.txt", function(cb) {
    cb(new Error("error 1"));
  });
  zipfile.addReadStreamLazy("hello2.txt", function(cb) {
    cb(new Error("error 2"));
  });
  zipfile.end(function() {
    throw new Error("should not call calculatedTotalSizeCallback in error conditions")
  });
  var gotError = false;
  try {
    zipfile.addBuffer(bufferFrom("a"), "a");
  } catch (err) {
    gotError = true;
  }
  if (!gotError) throw new Error("expected error for adding after calling end()");
})();

// Test:
//  * addBuffer deflates a large buffer in several pieces at once,
//    and the concatenation is still an ordinary deflate stream that an unzipper reads.
//  * a buffer too small to be worth splitting is deflated in one piece, byte for byte as before.
//  * the crc32 written in the zipfile is the one buffer-crc32 computes,
//    whichever implementation yazl picked to compute it.
(function() {
  var contents = {
    "big.xml": makeXmlishBuffer(9 * 1024 * 1024), // above the threshold: deflated in pieces.
    "small.xml": makeXmlishBuffer(64 * 1024),     // below the threshold: deflated in one piece.
  };
  var zipfile = new yazl.ZipFile();
  Object.keys(contents).forEach(function(fileName) {
    zipfile.addBuffer(contents[fileName], fileName);
  });
  zipfile.on("error", function(err) {
    throw err;
  });
  zipfile.end(function() {
    zipfile.outputStream.pipe(new BufferList(function(err, data) {
      if (err) throw err;
      yauzl.fromBuffer(data, function(err, zipfile) {
        if (err) throw err;
        zipfile.on("entry", function(entry) {
          var expectedContents = contents[entry.fileName];
          if (expectedContents == null) throw new Error("unexpected entry: " + entry.fileName);
          if (entry.compressionMethod !== 8) throw new Error("expected " + entry.fileName + " to be deflated. found compression method: " + entry.compressionMethod);

          var expectedCrc32 = crc32.unsigned(expectedContents);
          if (entry.crc32 !== expectedCrc32) throw new Error("wrong crc32 for " + entry.fileName + ". " + entry.crc32 + " !== " + expectedCrc32);

          var onePieceSize = zlib.deflateRawSync(expectedContents, {level: 6}).length;
          if (entry.fileName === "big.xml") {
            // A piece cannot back-reference the previous one, so splitting always costs a few bytes.
            if (!(entry.compressedSize > onePieceSize)) throw new Error("expected " + entry.fileName + " to be deflated in several pieces. " + entry.compressedSize + " <= " + onePieceSize);
            if (!(entry.compressedSize < onePieceSize * 1.01)) throw new Error("deflating " + entry.fileName + " in pieces cost more than 1% of the compressed size. " + entry.compressedSize + " vs " + onePieceSize);
          } else {
            if (entry.compressedSize !== onePieceSize) throw new Error("expected " + entry.fileName + " to be deflated in one piece. " + entry.compressedSize + " !== " + onePieceSize);
          }

          zipfile.openReadStream(entry, function(err, readStream) {
            if (err) throw err;
            readStream.pipe(new BufferList(function(err, data) {
              if (err) throw err;
              if (!expectedContents.equals(data)) throw new Error("unexpected contents for " + entry.fileName);
              console.log("parallel deflate(" + entry.fileName + "): pass");
            }));
          });
        });
      });
    }));
  });
})();

// Test:
//  * the crc32 of a streamed entry, accumulated chunk by chunk, is the one buffer-crc32 computes.
(function() {
  var expectedContents = fs.readFileSync(__filename);
  var expectedCrc32 = crc32.unsigned(expectedContents);
  var zipfile = new yazl.ZipFile();
  // The small highWaterMark forces the crc32 to be accumulated over many chunks.
  zipfile.addReadStream(fs.createReadStream(__filename, {highWaterMark: 1024}), "chunked.txt");
  zipfile.end(function() {
    zipfile.outputStream.pipe(new BufferList(function(err, data) {
      if (err) throw err;
      yauzl.fromBuffer(data, function(err, zipfile) {
        if (err) throw err;
        zipfile.on("entry", function(entry) {
          if (entry.crc32 !== expectedCrc32) throw new Error("wrong crc32 for " + entry.fileName + ". " + entry.crc32 + " !== " + expectedCrc32);
          console.log("chunked crc32: pass");
        });
      });
    }));
  });
})();

// Builds compressible but not repetitive ascii content of about byteLength bytes.
function makeXmlishBuffer(byteLength) {
  var lines = [];
  var totalLength = 0;
  for (var i = 0; totalLength < byteLength; i++) {
    var line = '<row id="' + i + '"><cell>value ' + (i % 97) + "</cell><cell>" + ((i * 7919) % 1000003) + "</cell></row>\n";
    lines.push(line);
    totalLength += line.length;
  }
  return bufferFrom(lines.join(""), "utf-8");
}

function bufferFrom(something, encoding) {
  bufferFrom = modern;
  try {
    return bufferFrom(something, encoding);
  } catch (e) {
    bufferFrom = legacy;
    return bufferFrom(something, encoding);
  }
  function modern(something, encoding) {
    return Buffer.from(something, encoding);
  }
  function legacy(something, encoding) {
    return new Buffer(something, encoding);
  }
}
