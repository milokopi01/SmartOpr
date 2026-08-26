function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var prompt = data.prompt;
    var maxWords = data.maxWords || 200; // Terima tetapan had perkataan
    var minWords = Math.floor(maxWords * 0.75); // Sasaran minimum 75% daripada maksimum

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("apieky");
    if (!sheet) {
      sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("apikey");
    }
    
    if (!sheet) {
      return respond({success: false, error: "Sheet bernama 'apieky' tidak dijumpai."});
    }

    var keys = sheet.getRange("A1:A" + sheet.getLastRow()).getValues().flat().filter(String);
    
    if (keys.length === 0) {
      return respond({success: false, error: "Tiada API Key dijumpai di lajur A."});
    }

    var resultText = "";
    var success = false;
    var lastErrorMessage = "";

    for (var i = 0; i < keys.length; i++) {
      var apiKey = keys[i].trim();
      
      try {
        var payload = {
          "model": "qwen/qwen3.6-27b", 
          "messages": [
            {
              "role": "system", 
              "content": `Anda adalah pegawai pelapor kerajaan Malaysia. Tugas: Tulis teks Laporan Satu Muka Surat (OPR).
              ARAHAN KETAT DAN MUTLAK:
              1. BAHASA: Hanya gunakan Bahasa Melayu Malaysia formal. Haram menggunakan bahasa Inggeris.
              2. KEPANJANGAN: Mesti antara ${minWords} hingga ${maxWords} patah perkataan.
              3. FORMAT: Jangan letak tajuk. Mula terus dengan ayat pertama laporan.
              4. STRUKTUR: Huraikan Pengenalan, Objektif, Pelaksanaan, dan Impak di dalam perenggan yang padat dan bersambung kemas.
              5. OUTPUT: JANGAN paparkan 'thinking process' (seperti "Here's the report..." atau "Let's plan..."). Output mesti 100% hanyalah teks laporan rasmi semata-mata.`
            },
            {
              "role": "user", 
              "content": prompt
            }
          ],
          "temperature": 0.2 // Suhu rendah menjadikan respons lebih patuh arahan (kurang kreatif/meraban)
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
        var json = JSON.parse(response.getContentText());

        if (response.getResponseCode() == 200 && json.choices && json.choices.length > 0) {
          resultText = json.choices[0].message.content;
          success = true;
          break; 
        } else {
          lastErrorMessage = json.error ? json.error.message : "Ralat: " + response.getContentText();
        }
      } catch (err) {
        lastErrorMessage = err.message;
        continue; 
      }
    }

    if (success) {
      return respond({success: true, text: resultText});
    } else {
      return respond({success: false, error: "Gagal: " + lastErrorMessage});
    }

  } catch (error) {
    return respond({success: false, error: error.message});
  }
}

function respond(responseObject) {
  return ContentService.createTextOutput(JSON.stringify(responseObject)).setMimeType(ContentService.MimeType.JSON);
}

function doOptions(e) {
  var headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
  return ContentService.createTextOutput("").setMimeType(ContentService.MimeType.JSON);
}