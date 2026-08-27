/**
 * BACKEND PENJANA OPR (Google Apps Script + Groq)
 * Versi 6 - pembetulan "jawapan mengarut" (proses berfikir bocor keluar)
 *
 * Punca masalah lama:
 *  - Model penaakulan memulangkan blok berfikir yang TERPOTONG, contoh bermula
 *    dengan "<think" tanpa tanda ">" ATAU tanpa tag langsung ("Here's a thinking
 *    process:"). Penapis lama hanya mengesan "<think>" bertutup, jadi teks
 *    berfikir dalam bahasa Inggeris terus dipaparkan sebagai laporan.
 *
 * Pembetulan:
 *  1. Pengesan proses berfikir jauh lebih ketat (tag tidak lengkap, mukadimah
 *     Inggeris, senarai analisis bernombor, "Program Info", dsb.)
 *  2. Semakan bahasa: jika teks bukan majoriti Bahasa Melayu, ia DITOLAK.
 *  3. Jika ditolak, sistem cuba semula (kunci lain / model lain) dan bukan
 *     memaparkan sampah.
 *  4. Hanya model bukan penaakulan digunakan secara lalai + had token lebih
 *     longgar supaya laporan tidak terpotong.
 */

// Model diuji mengikut urutan. Yang pertama berjaya akan digunakan.
var MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "openai/gpt-oss-120b"
];

// Bilangan percubaan maksimum keseluruhan (elak kuota terbakar)
var MAX_PERCUBAAN = 6;

var VERSI_SKRIP = "7.0-video-chunk";

// ID folder Google Drive khas untuk simpanan video aktiviti
var FOLDER_VIDEO_ID = "1l1RNAGy9jyVnFkxDvk9UMt4cTdqcDW_c";

/**
 * Muat naik video ke folder Google Drive dan pulangkan pautan awam
 * (pautan ini akan dijadikan Kod QR di dalam laporan OPR).
 */
function muatNaikVideo(data) {
  try {
    var b64 = String(data.fileData || "");
    if (b64.indexOf("base64,") !== -1) b64 = b64.split("base64,")[1];
    if (!b64) return respond({ success: false, error: "Tiada data video diterima." });

    var namaFail = String(data.fileName || ("video_" + new Date().getTime() + ".mp4"));
    var jenis = String(data.mimeType || "video/mp4");
    var blob = Utilities.newBlob(Utilities.base64Decode(b64), jenis, namaFail);

    var folder = DriveApp.getFolderById(FOLDER_VIDEO_ID);
    var fail = folder.createFile(blob);
    kongsiAwam(fail.getId());

    return respond({
      success: true,
      fileId: fail.getId(),
      name: fail.getName(),
      url: "https://drive.google.com/file/d/" + fail.getId() + "/view"
    });
  } catch (err) {
    return respond({ success: false, error: "Gagal memuat naik video: " + err });
  }
}

/**
 * Mulakan sesi "resumable upload" Google Drive.
 * Pelayar akan menghantar video terus ke URL yang dipulangkan (potongan demi
 * potongan), jadi TIADA had saiz daripada Apps Script.
 */
function mulaSesiVideo(data) {
  try {
    var namaFail = String(data.fileName || ("video_" + new Date().getTime() + ".mp4"));
    var jenis = String(data.mimeType || "video/mp4");

    var res = UrlFetchApp.fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true",
      {
        method: "post",
        contentType: "application/json; charset=UTF-8",
        headers: {
          Authorization: "Bearer " + ScriptApp.getOAuthToken(),
          "X-Upload-Content-Type": jenis
        },
        payload: JSON.stringify({ name: namaFail, mimeType: jenis, parents: [FOLDER_VIDEO_ID] }),
        muteHttpExceptions: true
      }
    );

    if (res.getResponseCode() >= 300) {
      return respond({ success: false, error: "Drive menolak permulaan muat naik (" + res.getResponseCode() + "): " + res.getContentText() });
    }

    var headers = res.getAllHeaders();
    var uploadUrl = headers["Location"] || headers["location"];
    if (!uploadUrl) return respond({ success: false, error: "Drive tidak memulangkan URL muat naik." });

    return respond({ success: true, uploadUrl: uploadUrl });
  } catch (err) {
    return respond({ success: false, error: "Gagal memulakan sesi muat naik: " + err });
  }
}

/**
 * Terima satu potongan video (base64) daripada pelayar dan tolak ke sesi
 * "resumable upload" Google Drive. Ini mengelak sekatan CORS pada pelayar.
 */
function terimaPotonganVideo(data) {
  try {
    var uploadUrl = String(data.uploadUrl || "");
    if (!uploadUrl) return respond({ success: false, error: "Tiada uploadUrl." });

    var b64 = String(data.chunk || "");
    if (b64.indexOf("base64,") !== -1) b64 = b64.split("base64,")[1];
    if (!b64) return respond({ success: false, error: "Potongan video kosong." });

    var bait = Utilities.base64Decode(b64);
    var mula = Number(data.start || 0);
    var jumlah = Number(data.total || 0);
    var hujung = mula + bait.length - 1;

    var res = UrlFetchApp.fetch(uploadUrl, {
      method: "put",
      contentType: "application/octet-stream",
      headers: { "Content-Range": "bytes " + mula + "-" + hujung + "/" + jumlah },
      payload: bait,
      muteHttpExceptions: true
    });

    var kod = res.getResponseCode();
    if (kod === 308) {
      var julat = res.getAllHeaders()["Range"] || res.getAllHeaders()["range"] || "";
      var seterusnya = julat ? parseInt(String(julat).split("-")[1], 10) + 1 : hujung + 1;
      return respond({ success: true, done: false, next: seterusnya });
    }
    if (kod === 200 || kod === 201) {
      var maklumat = {};
      try { maklumat = JSON.parse(res.getContentText()); } catch (e) {}
      return respond({ success: true, done: true, fileId: maklumat.id || "" });
    }
    return respond({ success: false, error: "Drive menolak potongan (" + kod + "): " + res.getContentText().slice(0, 300) });
  } catch (err) {
    return respond({ success: false, error: "Gagal menghantar potongan video: " + err });
  }
}

/** Kongsi fail "sesiapa yang ada pautan" dan pulangkan pautan tontonan. */
function siapkanVideo(data) {
  try {
    var fileId = String(data.fileId || "");
    if (!fileId) return respond({ success: false, error: "Tiada fileId." });
    kongsiAwam(fileId);
    return respond({
      success: true,
      fileId: fileId,
      url: "https://drive.google.com/file/d/" + fileId + "/view"
    });
  } catch (err) {
    return respond({ success: false, error: "Gagal menyiapkan pautan video: " + err });
  }
}

function kongsiAwam(fileId) {
  // Cuba API Drive dahulu (lebih tahan sekatan domain), kemudian DriveApp.
  try {
    UrlFetchApp.fetch("https://www.googleapis.com/drive/v3/files/" + fileId + "/permissions?supportsAllDrives=true", {
      method: "post",
      contentType: "application/json; charset=UTF-8",
      headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
      payload: JSON.stringify({ role: "reader", type: "anyone" }),
      muteHttpExceptions: true
    });
  } catch (e) { /* domain sekolah mungkin menghalang perkongsian awam */ }
  try {
    DriveApp.getFileById(fileId).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) { /* abaikan */ }
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    // Tindakan muat naik video ke Google Drive
    if (String(data.action || "") === "uploadVideo") {
      return muatNaikVideo(data);
    }
    if (String(data.action || "") === "startVideoUpload") {
      return mulaSesiVideo(data);
    }
    if (String(data.action || "") === "finishVideoUpload") {
      return siapkanVideo(data);
    }
    if (String(data.action || "") === "putVideoChunk") {
      return terimaPotonganVideo(data);
    }
    if (String(data.action || "") === "ping") {
      return respond({ success: true, version: VERSI_SKRIP, videoSupport: true });
    }
    var prompt = String(data.prompt || "").trim();

    if (!prompt) {
      return respond({
        success: false,
        error: "Arahan laporan (prompt) tidak boleh kosong. Jika ini permintaan video, " +
               "skrip yang di-deploy mungkin versi lama — sila deploy semula code.gs terbaru."
      });
    }

    var maxWords = parseInt(data.maxWords, 10);
    if (isNaN(maxWords)) maxWords = 200;
    maxWords = Math.min(400, Math.max(50, maxWords));
    var minWords = Math.floor(maxWords * 0.75);

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("apieky") || ss.getSheetByName("apikey");

    if (!sheet) {
      return respond({ success: false, error: "Sheet bernama 'apieky' tidak dijumpai." });
    }

    var keys = sheet.getRange("A1:A" + sheet.getLastRow()).getValues().flat().filter(String);
    if (keys.length === 0) {
      return respond({ success: false, error: "Tiada API Key dijumpai di lajur A." });
    }

    var systemPrompt =
      "Anda ialah pegawai pelapor sekolah di Malaysia. Tugas anda menulis teks Laporan Satu Muka Surat (OPR).\n" +
      "ARAHAN KETAT DAN MUTLAK:\n" +
      "1. BAHASA: Gunakan Bahasa Melayu Malaysia baku sepenuhnya. DILARANG sama sekali menggunakan perkataan, " +
      "istilah atau ayat bahasa Inggeris, bahasa rojak atau bahasa campuran.\n" +
      "2. KEPANJANGAN: Wajib antara " + minWords + " hingga " + maxWords + " patah perkataan. " +
      "JANGAN sesekali melebihi " + maxWords + " patah perkataan.\n" +
      "3. FORMAT: Tiada tajuk, tiada senarai bernombor, tiada tanda markdown (*, #, -). " +
      "Hasilkan 2 hingga 3 perenggan padat sahaja.\n" +
      "4. STRUKTUR: Huraikan pengenalan, objektif, pelaksanaan dan impak secara bersambung kemas.\n" +
      "5. OUTPUT: Mula terus dengan ayat pertama laporan. DILARANG menulis proses berfikir, " +
      "analisis arahan, tag <think>, senarai semak, atau mukadimah seperti \"Berikut ialah laporan\" " +
      "atau \"Here is the report\".";

    // Ruang token lebih longgar supaya laporan tidak terpotong di tengah jalan.
    var maxTokens = Math.min(2000, Math.round(maxWords * 3.2) + 200);

    var resultText = "";
    var success = false;
    var lastErrorMessage = "";
    var modelDigunakan = "";
    var percubaan = 0;

    for (var m = 0; m < MODELS.length && !success; m++) {
      for (var i = 0; i < keys.length && !success; i++) {
        if (percubaan >= MAX_PERCUBAAN) break;
        percubaan++;

        var apiKey = String(keys[i]).trim();

        try {
          var payload = {
            "model": MODELS[m],
            "messages": [
              { "role": "system", "content": systemPrompt },
              {
                "role": "user",
                "content": prompt +
                  "\n\n(Ingat: Bahasa Melayu Malaysia sahaja, maksimum " + maxWords +
                  " patah perkataan. Balas terus dengan perenggan laporan, tanpa sebarang analisis atau proses berfikir.)"
              }
            ],
            "temperature": 0.2,
            "top_p": 0.9,
            "max_completion_tokens": maxTokens
          };

          // Model penaakulan mesti menyembunyikan proses fikir.
          if (MODELS[m].indexOf("gpt-oss") !== -1 || MODELS[m].indexOf("qwen") !== -1 ||
              MODELS[m].indexOf("deepseek") !== -1) {
            payload.reasoning_format = "hidden";
            payload.reasoning_effort = "low";
          }

          var hasil = panggilGroq(apiKey, payload, maxWords);

          if (hasil.ok) {
            resultText = hasil.teks;
            modelDigunakan = MODELS[m];
            success = true;
          } else {
            lastErrorMessage = hasil.error;

            // Jika parameter tidak disokong, cuba semula tanpa parameter itu.
            if (/reasoning_format|reasoning_effort/i.test(lastErrorMessage)) {
              delete payload.reasoning_format;
              delete payload.reasoning_effort;
              var hasil2 = panggilGroq(apiKey, payload, maxWords);
              if (hasil2.ok) {
                resultText = hasil2.teks;
                modelDigunakan = MODELS[m];
                success = true;
              } else {
                lastErrorMessage = hasil2.error;
              }
            }
          }
        } catch (err) {
          lastErrorMessage = err.message;
        }
      }
    }

    if (!success) {
      return respond({
        success: false,
        error: "Gagal menjana laporan yang sah. " + lastErrorMessage + " Sila tekan Jana sekali lagi."
      });
    }

    return respond({
      success: true,
      text: resultText,
      words: kiraPerkataan(resultText),
      maxWords: maxWords,
      model: modelDigunakan
    });

  } catch (error) {
    return respond({ success: false, error: error.message });
  }
}

/** Satu panggilan ke Groq + semua penapisan/pengesahan. */
function panggilGroq(apiKey, payload, maxWords) {
  var options = {
    "method": "post",
    "headers": {
      "Authorization": "Bearer " + apiKey,
      "Content-Type": "application/json"
    },
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };

  var response = UrlFetchApp.fetch("https://api.groq.com/openai/v1/chat/completions", options);
  var kod = response.getResponseCode();
  var mentah = response.getContentText();
  var json;
  try { json = JSON.parse(mentah); } catch (e) { json = null; }

  if (kod != 200 || !json || !json.choices || json.choices.length === 0) {
    var mesej = (json && json.error && json.error.message) ? json.error.message : ("Ralat " + kod + ".");
    return { ok: false, error: mesej };
  }

  var teks = String(json.choices[0].message.content || "");
  var calon = ambilJawapanAkhir(teks);

  if (!calon) {
    return { ok: false, error: "Model memulangkan proses berfikir, bukan laporan." };
  }

  calon = hadkanPerkataan(bersihkanBahasa(calon), maxWords);

  if (kiraPerkataan(calon) < 40) {
    return { ok: false, error: "Teks laporan terlalu pendek atau terpotong." };
  }

  if (!kebanyakanBahasaMelayu(calon)) {
    return { ok: false, error: "Teks yang dijana bukan Bahasa Melayu." };
  }

  return { ok: true, teks: calon };
}

/**
 * Ambil jawapan akhir dan tolak proses fikir.
 * Memulangkan "" jika teks itu sebenarnya proses berfikir (maka ditolak).
 */
function ambilJawapanAkhir(teks) {
  var hasil = String(teks || "").trim();

  // 1) Jika ada tag penutup (walaupun tidak sempurna), ambil bahagian selepasnya.
  var padananTutup = hasil.match(/<\s*\/\s*think[^>]*>?/gi);
  if (padananTutup) {
    var terakhir = padananTutup[padananTutup.length - 1];
    var idx = hasil.lastIndexOf(terakhir);
    hasil = hasil.substring(idx + terakhir.length).trim();
  }

  // 2) Tag pembuka yang masih tinggal (termasuk "<think" tanpa ">") = terpotong.
  if (/<\s*\/?\s*think/i.test(hasil)) return "";

  // 3) Corak proses berfikir tanpa tag.
  var corakBerfikir = [
    /here'?s? (a|my|the) (thinking|thought) process/i,
    /thinking process/i,
    /let me (think|analyz|break)/i,
    /^\s*\d+\.\s*(analyze|analyse|understand|plan|draft|review)/im,
    /analyz(e|ing) user input/i,
    /user (input|request|prompt)\s*:/i,
    /program info\s*:/i,
    /output generation/i,
    /(strict|mandatory) instructions?\s*:/i,
    /word count\s*:/i,
    /^\s*-\s*(role|task|language|length|format|structure|output)\s*:/im
  ];
  for (var i = 0; i < corakBerfikir.length; i++) {
    if (corakBerfikir[i].test(hasil)) return "";
  }

  return hasil;
}

/** Semak teks benar-benar Bahasa Melayu (elak jawapan Inggeris lolos). */
function kebanyakanBahasaMelayu(teks) {
  var t = String(teks).toLowerCase();
  var kata = t.match(/[a-zà-ÿ']+/g) || [];
  if (kata.length < 20) return false;

  var penandaBM = ["yang", "dan", "ini", "itu", "dengan", "untuk", "pada", "telah", "adalah",
                   "ialah", "serta", "dalam", "oleh", "akan", "kepada", "juga", "murid",
                   "sekolah", "program", "aktiviti", "objektif", "impak", "pihak", "dapat",
                   "bagi", "secara", "para", "hasil", "guru", "berjaya", "melalui"];
  var penandaEN = ["the", "and", "of", "is", "was", "were", "with", "by", "for", "this",
                   "that", "are", "from", "their", "they", "has", "have", "been", "which",
                   "while", "should", "there", "students", "school", "report"];

  var bm = 0, en = 0;
  for (var i = 0; i < kata.length; i++) {
    if (penandaBM.indexOf(kata[i]) !== -1) bm++;
    if (penandaEN.indexOf(kata[i]) !== -1) en++;
  }

  // Sekurang-kurangnya 6% penanda BM, dan penanda BM mesti mengatasi Inggeris.
  return (bm / kata.length) >= 0.06 && bm > en;
}

/** Buang blok "berfikir", tanda markdown, mukadimah dan ayat bahasa Inggeris. */
function bersihkanBahasa(teks) {
  var hasil = String(teks || "");

  // Buang blok penaakulan (walaupun tag tidak sempurna)
  hasil = hasil.replace(/<\s*think[^>]*>[\s\S]*?<\s*\/\s*think[^>]*>/gi, "");
  hasil = hasil.replace(/<\s*\/?\s*think[^>]*>?/gi, "");

  // Buang tanda markdown
  hasil = hasil.replace(/[*#_`>]+/g, "");

  // Buang mukadimah
  hasil = hasil.replace(/^\s*(here is|here's|here are|sure|certainly|okay|below is|draft|report)\b[^\n:.]*[:.]?\s*/i, "");
  hasil = hasil.replace(/^\s*(berikut(nya)?( ialah| adalah)?|laporan)\s*:\s*/i, "");

  // Buang baris label seperti "Tajuk:", "Objektif:" jika berdiri sendiri
  hasil = hasil.replace(/^\s*(tajuk|title|word count|jumlah perkataan)\s*:.*$/gim, "");

  // Buang ayat yang masih dalam bahasa Inggeris
  var perenggan = hasil.split(/\n{2,}/).map(function (p) {
    var ayat = p.match(/[^.!?]+[.!?]*/g) || [p];
    return ayat.filter(function (a) { return !ayatBahasaInggeris(a); })
               .map(function (a) { return a.trim(); })
               .join(" ");
  }).filter(function (p) { return p.trim().length > 0; });

  hasil = perenggan.join("\n\n");

  // Gantikan istilah Inggeris yang tinggal
  var ganti = [
    ["one page report", "laporan sehalaman"], ["report", "laporan"], ["objectives", "objektif"],
    ["objective", "objektif"], ["activities", "aktiviti"], ["activity", "aktiviti"],
    ["impact", "impak"], ["participants", "peserta"], ["students", "murid"], ["student", "murid"],
    ["teachers", "guru"], ["teacher", "guru"], ["school", "sekolah"], ["conclusion", "kesimpulan"],
    ["introduction", "pendahuluan"], ["successful", "berjaya"], ["success", "kejayaan"],
    ["committee", "jawatankuasa"], ["session", "sesi"], ["event", "acara"],
    ["feedback", "maklum balas"], ["parents", "ibu bapa"], ["community", "komuniti"],
    ["management", "pengurusan"], ["achievement", "pencapaian"], ["outcome", "hasil"],
    ["target", "sasaran"], ["skills", "kemahiran"], ["skill", "kemahiran"],
    ["organized", "dianjurkan"], ["organised", "dianjurkan"], ["held", "diadakan"],
    ["overall", "secara keseluruhan"], ["therefore", "oleh itu"], ["however", "namun begitu"],
    ["venue", "tempat"], ["photo", "gambar"], ["photos", "gambar"]
  ];

  ganti.forEach(function (pair) {
    var re = new RegExp("\\b" + pair[0].replace(/ /g, "\\s+") + "\\b", "gi");
    hasil = hasil.replace(re, function (padanan) {
      return /^[A-Z]/.test(padanan) ? pair[1].charAt(0).toUpperCase() + pair[1].slice(1) : pair[1];
    });
  });

  return hasil.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function ayatBahasaInggeris(ayat) {
  var penanda = ["the","and","of","is","was","were","with","by","for","this","that","are","from",
                 "their","they","has","have","been","which","while","also","will","can","should",
                 "there","it","in","on","at","as","an","to","be","not","all","more","than","our","its","we","you"];
  var kata = (String(ayat).toLowerCase().match(/[a-z']+/g) || []);
  if (kata.length < 4) return false;
  var bil = kata.filter(function (k) { return penanda.indexOf(k) !== -1; }).length;
  return (bil / kata.length) >= 0.22;
}

function kiraPerkataan(teks) {
  return String(teks).trim().split(/\s+/).filter(String).length;
}

/** Potong pada penghujung ayat supaya tidak melebihi had perkataan. */
function hadkanPerkataan(teks, maxWords) {
  var perenggan = String(teks).split(/\n{2,}/);
  var jumlah = 0;
  var hasil = [];

  for (var i = 0; i < perenggan.length; i++) {
    var ayatSenarai = perenggan[i].match(/[^.!?]+[.!?]*/g) || [perenggan[i]];
    var simpan = [];
    for (var j = 0; j < ayatSenarai.length; j++) {
      var bil = kiraPerkataan(ayatSenarai[j]);
      if (jumlah + bil > maxWords) { jumlah = maxWords; break; }
      jumlah += bil;
      simpan.push(ayatSenarai[j].trim());
    }
    if (simpan.length) hasil.push(simpan.join(" "));
    if (jumlah >= maxWords) break;
  }

  var akhir = hasil.join("\n\n").trim();
  if (!akhir) akhir = String(teks).trim().split(/\s+/).slice(0, maxWords).join(" ");
  if (akhir && !/[.!?]$/.test(akhir)) akhir += ".";
  return akhir;
}

function respond(responseObject) {
  return ContentService.createTextOutput(JSON.stringify(responseObject))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return respond({ success: true, text: "Perkhidmatan penjana OPR sedia digunakan." });
}

function doOptions(e) {
  return ContentService.createTextOutput("").setMimeType(ContentService.MimeType.TEXT);
}
