// File: server.js (REVISED FOR TELEGRAM & WEB CHAT INTEGRATION)

require('dotenv').config();
process.noDeprecation = true;

const express = require("express");
const path = require("path");
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api'); // <-- Impor baru

// Impor dari modul-modul kita
const { weatherTool, getWeatherDataWttrIn } = require('./public/cuaca.js');
const { searchTool, performWebSearchImplementation } = require('./public/search.js');
const { cloudinaryTool, uploadImageImplementation, listImagesImplementation } = require('./public/cloudinary.js');

// =================================================================
// KONFIGURASI APLIKASI
// =================================================================
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, "public")));
app.use(cors());

const geminiModel = "gemini-2.0-flash";
const geminiApiKey = process.env.GEMINI_API_KEY;
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;

// =================================================================
// LOGIKA INTI GEMINI (Dibuat menjadi fungsi yang bisa dipakai ulang)
// =================================================================

// Objek untuk menyimpan riwayat chat per pengguna Telegram
// Kunci: chat.id, Nilai: array history
const telegramChatHistories = {};

async function runGeminiConversation(prompt, history, imageData, mimeType) {
    if (!geminiApiKey) {
        throw new Error("Gemini API Key not configured.");
    }

    const userParts = [];
    if (prompt) userParts.push({ text: prompt });
    if (imageData && mimeType) {
        userParts.push({ inlineData: { mimeType: mimeType, data: imageData } });
    }
    
    if (userParts.length === 0) {
        throw new Error("Prompt atau gambar tidak boleh kosong.");
    }
    
    let currentContents = [...(history || []), { role: "user", parts: userParts }];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiApiKey}`;

    try {
        console.log(`[Gemini Core] Sending to Gemini. Contents length: ${currentContents.length}`);
        
        let payload = {
            contents: currentContents,
            tools: [weatherTool, searchTool, cloudinaryTool],
        };

        let apiResponse = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        if (!apiResponse.ok) {
            const errorBody = await apiResponse.text();
            console.error(`[Gemini Core] API request failed:`, apiResponse.status, errorBody);
            throw new Error(`Gemini API error: ${apiResponse.status} - ${errorBody.substring(0, 200)}`);
        }

        let geminiResponseData = await apiResponse.json();
        
        // Cek jika ada permintaan Function Call
        let candidate = geminiResponseData.candidates?.[0];
        let functionCallPart = candidate?.content?.parts?.find(p => p.functionCall);

        // Jika ada Function Call, eksekusi dulu
        if (functionCallPart && functionCallPart.functionCall) {
            console.log("[Gemini Core] Function call requested:", functionCallPart.functionCall.name);
            const functionCall = functionCallPart.functionCall;
            const functionName = functionCall.name;
            const args = functionCall.args;
            
            // Simpan history sebelum eksekusi tool
            currentContents.push(candidate.content);

            let functionResponseData;
            // Routing eksekusi fungsi
            if (functionName === "getCurrentWeather") {
                functionResponseData = await getWeatherDataWttrIn(args.city);
            } else if (functionName === "performWebSearch") {
                functionResponseData = await performWebSearchImplementation(args.query);
            } else if (functionName === "uploadImageToCloudinary") {
                functionResponseData = await uploadImageImplementation(imageData, args.folder, args.public_id);
            } else if (functionName === "listImagesInCloudinary") {
                functionResponseData = await listImagesImplementation(args.folder);
            } else {
                console.error(`[Gemini Core] Unknown function call: ${functionName}`);
                functionResponseData = { error: `Fungsi ${functionName} tidak dikenal.` };
            }
            
            // Tambahkan hasil eksekusi ke history
            currentContents.push({
                role: "user", // Dalam API, hasil tool dikirim dengan role 'user' (atau 'tool')
                parts: [{ functionResponse: { name: functionName, response: functionResponseData } }]
            });

            // Kirim kembali ke Gemini untuk mendapatkan jawaban akhir
            console.log("[Gemini Core] Sending tool result back to Gemini.");
            payload.contents = currentContents; // Update payload dengan history baru
            
            apiResponse = await fetch(url, {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
            });

            if (!apiResponse.ok) {
                 const errorBody = await apiResponse.text();
                 console.error(`[Gemini Core] API request (after tool) failed:`, apiResponse.status, errorBody);
                 throw new Error(`Gemini API error after tool: ${apiResponse.status} - ${errorBody.substring(0, 200)}`);
            }
            
            geminiResponseData = await apiResponse.json();
        }

        // Proses respons akhir (baik dari awal atau setelah tool-use)
        const finalCandidate = geminiResponseData.candidates?.[0];
        if (!finalCandidate || finalCandidate.finishReason === "SAFETY" || !finalCandidate.content?.parts?.[0]?.text) {
             console.warn("[Gemini Core] No valid final response.", JSON.stringify(geminiResponseData, null, 2).substring(0, 500));
             let reason = finalCandidate?.finishReason || "Tidak ada kandidat respons";
             if (geminiResponseData.promptFeedback?.blockReason) {
                 reason = `Permintaan diblokir: ${geminiResponseData.promptFeedback.blockReason}`;
             }
             return `Maaf, terjadi masalah: ${reason}. Coba lagi nanti.`;
        }

        const finalText = finalCandidate.content.parts[0].text;
        // Kembalikan teks akhir dan history yang diperbarui
        return {
            responseText: finalText,
            updatedHistory: [...currentContents, finalCandidate.content]
        };

    } catch (err) {
        console.error("[Gemini Core] Uncaught error:", err);
        throw err; // Lempar error agar bisa ditangani oleh pemanggil
    }
}

// =================================================================
// BAGIAN TELEGRAM BOT
// =================================================================
if (!telegramToken) {
    console.warn("TELEGRAM_BOT_TOKEN tidak ditemukan di .env. Bot Telegram tidak akan berjalan.");
} else {
    const bot = new TelegramBot(telegramToken, { polling: true });
    console.log("Telegram Bot is running and polling for messages...");

    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const userInput = msg.text;

        // Abaikan pesan yang bukan teks (untuk saat ini)
        if (!userInput) return;

        // Abaikan command (dimulai dengan '/')
        if (userInput.startsWith('/')) {
             if (userInput === '/start') {
                 bot.sendMessage(chatId, "Halo! Saya adalah Asisten AI Gemini Anda. Kirimkan saya pesan untuk memulai percakapan.");
             } else if (userInput === '/clear') {
                 delete telegramChatHistories[chatId]; // Hapus riwayat chat
                 bot.sendMessage(chatId, "Riwayat percakapan telah dihapus.");
             }
            return;
        }

        try {
            // Tampilkan status "typing..." di Telegram
            bot.sendChatAction(chatId, 'typing');

            // Ambil riwayat chat untuk user ini
            const userHistory = telegramChatHistories[chatId] || [];

            console.log(`[Telegram] Processing message from chatId: ${chatId}`);
            
            // Panggil fungsi inti Gemini
            const result = await runGeminiConversation(userInput, userHistory, null, null);

            // Perbarui riwayat chat untuk user ini
            telegramChatHistories[chatId] = result.updatedHistory;
            
            // Kirim balasan ke Telegram (mendukung Markdown)
            bot.sendMessage(chatId, result.responseText, { parse_mode: 'Markdown' });

        } catch (error) {
            console.error(`[Telegram] Error processing message for chat ${chatId}:`, error);
            bot.sendMessage(chatId, `Maaf, terjadi kesalahan: ${error.message}`);
        }
    });

    bot.on('polling_error', (error) => {
        console.error('[Telegram Polling Error]', error.code, error.message);
    });
}

// =================================================================
// ENDPOINT UNTUK WEB CHAT (TETAP BERFUNGSI)
// Ini sekarang menjadi lebih sederhana karena menggunakan fungsi inti `runGeminiConversation`
// =================================================================

app.post("/api/chat", async (req, res) => {
    const { prompt, history, imageData, mimeType } = req.body;

    try {
        console.log("[Web Chat] Processing request.");
        const result = await runGeminiConversation(prompt, history, imageData, mimeType);
        // Untuk web chat, kita kirim respons dan history baru agar client bisa mengelolanya
        res.json({
            response: result.responseText,
            updatedHistory: result.updatedHistory
        });
    } catch (error) {
        console.error("[Web Chat] Error:", error);
        res.status(500).json({ error: `Server error: ${error.message}` });
    }
});

// Endpoint lama tidak lagi diperlukan karena logikanya sudah disatukan.
// Jika frontend Anda masih menggunakan /start dan /execute-tool,
// Anda perlu menyesuaikannya agar hanya memanggil /api/chat.

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}. Web chat & Telegram bot are active.`));