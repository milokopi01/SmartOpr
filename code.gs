/**
 * BACKEND PENJANA OPR (Google Apps Script + Groq)
 * Kemas kini:
 *  - Senarai model berganti (fallback) supaya tidak gagal jika satu model tidak sah/ditamatkan
 *  - reasoning_format: "hidden" + pembuang <think> supaya "proses berfikir" tidak keluar
 *  - max_completion_tokens dikira dari had perkataan supaya teks tidak panjang mengarut
 *  - Penapis bahasa: buang ayat bahasa Inggeris & tanda markdown (elak bahasa rojak)
 *  - Pemotong perkataan di pelayan: hasil dijamin tidak melebihi had perkataan
 */

// Model diuji mengikut urutan. Yang pertama berjaya akan digunakan.
var MODELS = [
  "llama-3.3-70b-versatile",
  "openai/gpt-oss-120b",
  "qwen/qwen3-32b"
];

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var prompt = String(data.prompt || "").trim();

    if (!prompt) {
      return respond({ success: false, error: "Arahan laporan (prompt) tidak boleh kosong." });
    }

    var maxWords = parseInt(data.maxWords, 10);
    if (isNaN(maxWords)) maxWords = 200;
    maxWords = Math.min(400, Math.max(50, maxWords));
    var minWords = Math.floor(maxWords * 0.75);

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("apieky")
             || SpreadsheetApp.getActiveSpreadsheet().getSheetByName("apikey");

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
      "5. OUTPUT: Balas dengan teks laporan rasmi sahaja. Jangan tunjukkan proses berfikir, " +
      "jangan tulis mukadimah seperti \"Berikut ialah laporan\" atau \"Here is the report\".";

    // Anggaran token: 1 perkataan BM ~ 2.2 token. Tambah sedikit ruang, tetapi kekal terhad.
    var maxTokens = Math.min(1200, Math.round(maxWords * 2.6) + 80);

    var resultText = "";
    var success = false;
    var lastErrorMessage = "";
    var modelDigunakan = "";

    for (var m = 0; m < MODELS.length && !success; m++) {
      for (var i = 0; i < keys.length && !success; i++) {
        var apiKey = String(keys[i]).trim();

        try {
          var payload = {
            "model": MODELS[m],
            "messages": [
              { "role": "system", "content": systemPrompt },
              { "role": "user", "content": prompt + "\n\n(Ingat: Bahasa Melayu Malaysia sahaja, maksimum " + maxWords + " patah perkataan.)" }
            ],
            "temperature": 0.2,
            "top_p": 0.9,
            "max_completion_tokens": maxTokens,
            "reasoning_format": "hidden" // Diabaikan oleh model bukan penaakulan
          };

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
          var json = JSON.parse(response.getContentText());

          if (kod == 200 && json.choices && json.choices.length > 0) {
            resultText = json.choices[0].message.content || "";
            modelDigunakan = MODELS[m];
            success = true;
          } else {
            lastErrorMessage = (json.error && json.error.message) ? json.error.message : ("Ralat " + kod + ": " + response.getContentText());
            // Jika parameter reasoning_format tidak disokong, cuba semula tanpa parameter itu
            if (lastErrorMessage.indexOf("reasoning_format") !== -1) {
              delete payload.reasoning_format;
              options.payload = JSON.stringify(payload);
              var response2 = UrlFetchApp.fetch("https://api.groq.com/openai/v1/chat/completions", options);
              var json2 = JSON.parse(response2.getContentText());
              if (response2.getResponseCode() == 200 && json2.choices && json2.choices.length > 0) {
                resultText = json2.choices[0].message.content || "";
                modelDigunakan = MODELS[m];
                success = true;
              }
            }
          }
        } catch (err) {
          lastErrorMessage = err.message;
        }
      }
    }

    if (!success) {
      return respond({ success: false, error: "Gagal: " + lastErrorMessage });
    }

    var teksBersih = hadkanPerkataan(bersihkanBahasa(resultText), maxWords);

    return respond({
      success: true,
      text: teksBersih,
      words: kiraPerkataan(teksBersih),
      maxWords: maxWords,
      model: modelDigunakan
    });

  } catch (error) {
    return respond({ success: false, error: error.message });
  }
}

/** Buang blok "berfikir", tanda markdown, mukadimah dan ayat bahasa Inggeris. */
function bersihkanBahasa(teks) {
  var hasil = String(teks || "");

  // Buang blok penaakulan
  hasil = hasil.replace(/<think>[\s\S]*?<\/think>/gi, "");
  hasil = hasil.replace(/<\/?think>/gi, "");

  // Buang tanda markdown
  hasil = hasil.replace(/[*#_`>]+/g, "");

  // Buang mukadimah
  hasil = hasil.replace(/^\s*(here is|here's|here are|sure|certainly|okay|below is|draft|report)\b[^\n:.]*[:.]?\s*/i, "");
  hasil = hasil.replace(/^\s*(berikut(nya)?( ialah| adalah)?|laporan)\s*:\s*/i, "");

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

  return hasil.replace(/[ \t]{2,}/g, " ").trim();
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
