const { Pool } = require("pg"); require("dotenv").config(); const express = require("express"); const http = require("http"); const { Server } = require("socket.io"); const QRCode = require("qrcode"); const generatePayload = require("promptpay-qr"); const multer = require("multer"); const crypto = require("crypto"); const fs = require("fs"); const path = require("path"); const app = express(); const server = http.createServer(app); const io = new Server(server);

const ALLOWED_ENVIRONMENTS = [ "development", "staging", "production" ];
const APP_ENV = String(process.env.APP_ENV || process.env.NODE_ENV || "development").trim().toLowerCase();

if (!ALLOWED_ENVIRONMENTS.includes(APP_ENV)) {
    throw new Error(`APP_ENV ไม่ถูกต้อง: ${APP_ENV} (ใช้ development, staging หรือ production)`);
}

const IS_DEVELOPMENT = APP_ENV === "development";
const IS_PRODUCTION = APP_ENV === "production";
const IS_DEPLOYED = APP_ENV === "staging" || APP_ENV === "production";
const PORT = Number(process.env.PORT) || 3000;
const APP_VERSION = String(process.env.APP_VERSION || "dev").trim();
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const DATABASE_SSL = String(process.env.DATABASE_SSL || "true").trim().toLowerCase() !== "false";

const DATA_DIR = path.resolve(
    __dirname,
    String(process.env.DATA_DIR || path.join("data", APP_ENV))
);

const PUBLIC_DIR_CANDIDATE = path.resolve(
    __dirname,
    String(process.env.PUBLIC_DIR || "public")
);

const PUBLIC_DIR = fs.existsSync(PUBLIC_DIR_CANDIDATE)
    ? PUBLIC_DIR_CANDIDATE
    : (IS_DEVELOPMENT ? __dirname : PUBLIC_DIR_CANDIDATE);

const LEGACY_STATIC_MODE = PUBLIC_DIR === __dirname;

const MOBILE_SESSION_TTL_MS = 15 * 60 * 1000;
const CUSTOM_SOUND_MIN_AMOUNT = 100;
const CUSTOM_SOUND_MAX_BYTES = 3 * 1024 * 1024;
const CUSTOM_SOUND_TTL_MS = 30 * 60 * 1000;
const CUSTOM_SOUND_AFTER_USE_TTL_MS = 15 * 60 * 1000;
const CUSTOM_SOUND_DIR = path.join(DATA_DIR, "custom-audio");

const VIDEO_DONATION_MIN_AMOUNT = 10;
const VIDEO_DONATION_MAX_DURATION = 20;
const VIDEO_DONATION_MAX_START = 12 * 60 * 60;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(CUSTOM_SOUND_DIR, { recursive: true });

function validateRuntimeConfig() {
    const required = ["DATABASE_URL"];

    if (IS_DEPLOYED) {
        required.push(
            "ADMIN_KEY",
            "PROMPTPAY_ID",
            "EASYSLIP_API_KEY",
            "PUBLIC_BASE_URL"
        );
    }

    const missing = required.filter(
        key => !String(process.env[key] || "").trim()
    );

    if (missing.length) {
        throw new Error(
            `Environment variables ไม่ครบ: ${missing.join(", ")}`
        );
    }

    if (IS_DEPLOYED && !PUBLIC_BASE_URL.startsWith("https://")) {
        throw new Error(
            "PUBLIC_BASE_URL ของ staging/production ต้องเป็น HTTPS"
        );
    }

    if (IS_DEPLOYED && !fs.existsSync(PUBLIC_DIR_CANDIDATE)) {
        throw new Error(`ไม่พบ public directory: ${PUBLIC_DIR_CANDIDATE}`);
    }
}

app.disable("x-powered-by");

if (IS_DEPLOYED) {
    app.set("trust proxy", 1);
}

app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=()"
    );
    res.setHeader("X-AMR29-Environment", APP_ENV);
    res.setHeader("X-AMR29-Version", APP_VERSION);
    next();
});

app.use(express.json({ limit: "1mb" }));

app.use(
    express.urlencoded({
        extended: true,
        limit: "1mb"
    })
);

if (LEGACY_STATIC_MODE) {
    const blockedExact = new Set([
        "/server.js",
        "/package.json",
        "/package-lock.json",
        "/donations.db",
        "/tokens.json",
        "/.env"
    ]);

    const blockedPrefixes = [
        "/data/",
        "/.amr29-private/",
        "/.git/",
        "/node_modules/"
    ];

    app.use((req, res, next) => {
        const lower = decodeURIComponent(
            String(req.path || "")
        ).toLowerCase();

        if (
            blockedExact.has(lower) ||
            blockedPrefixes.some(prefix => lower.startsWith(prefix)) ||
            lower.endsWith(".db") ||
            lower.endsWith(".db-journal") ||
            lower.endsWith(".sqlite") ||
            lower.endsWith(".sqlite3")
        ) {
            return res.status(404).send("Not Found");
        }

        next();
    });
}

app.use(
    express.static(PUBLIC_DIR, {
        dotfiles: "ignore",
        etag: true,
        maxAge: IS_PRODUCTION ? "1h" : 0,

        setHeaders(res, filePath) {
            if (filePath.toLowerCase().endsWith(".html")) {
                res.setHeader(
                    "Cache-Control",
                    "no-store, no-cache, must-revalidate"
                );
            } else if (!IS_PRODUCTION) {
                res.setHeader("Cache-Control", "no-store");
            }
        }
    })
);

app.get("/health", (req, res) => {
    res.json({
        success: true,
        service: "amr29-control-center",
        environment: APP_ENV,
        version: APP_VERSION,
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
    });
});

app.get("/api/version", (req, res) => {
    res.json({
        success: true,
        environment: APP_ENV,
        version: APP_VERSION
    });
});

if (!DATABASE_URL) {
    throw new Error(
        "ยังไม่ได้ตั้ง DATABASE_URL สำหรับ Supabase PostgreSQL"
    );
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_SSL
        ? {
              rejectUnauthorized: false
          }
        : false,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

pool.on("error", error => {
    console.error("PostgreSQL Pool Error:", error);
});

function toPostgresSql(sql) {
    let index = 0;
    return String(sql).replace(/\?/g, () => `$${++index}`);
}

async function dbRun(sql, params = [], executor = pool) {
    const result = await executor.query(toPostgresSql(sql), params);

    return {
        lastID: result.rows?.[0]?.id ?? null,
        changes: Number(result.rowCount || 0),
        rows: result.rows || []
    };
}

async function dbGet(sql, params = [], executor = pool) {
    const result = await executor.query(toPostgresSql(sql), params);
    return result.rows?.[0] || null;
}

async function dbAll(sql, params = [], executor = pool) {
    const result = await executor.query(toPostgresSql(sql), params);
    return result.rows || [];
}

const defaultSettings = {
    goal_title: "เป้าหมายสนับสนุน",
    goal_target: "5000",
    goal_enabled: "1",
    goal_base_total: "0",

    alert_tts_enabled: "1",
    alert_read_message: "1",
    alert_tts_rate: "1",
    alert_big_amount: "500",
    alert_mega_amount: "1000",
    alert_after_tts_delay: "1000",
    alert_no_tts_display_time: "4500",

    alert_sound_volume: "70",
    alert_custom_sound_volume: "70",
    alert_tts_volume: "100",
    alert_video_volume: "80",
    alert_master_volume: "100",

    alert_sound_muted: "0",
    alert_custom_sound_muted: "0",
    alert_tts_muted: "0",
    alert_video_muted: "0",

    alert_tts_pitch: "1",
    alert_tts_voice_uri: "auto",
    alert_tts_voice_name: "",
    alert_tts_lang: "th-TH"
};

async function ensureColumn(tableName, columnName, definition) {
    const safe = /^[A-Za-z_][A-Za-z0-9_]*$/;

    if (!safe.test(tableName) || !safe.test(columnName)) {
        throw new Error("Database identifier ไม่ถูกต้อง");
    }

    await dbRun(`
        ALTER TABLE ${tableName}
        ADD COLUMN IF NOT EXISTS ${columnName}
        ${definition}
    `);
}

async function initDatabase() {
    await dbRun(`
        CREATE TABLE IF NOT EXISTS donations (
            id BIGSERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            message TEXT,
            amount NUMERIC(12,2) NOT NULL,
            trans_ref TEXT UNIQUE,
            video_url TEXT,
            video_id TEXT,
            video_start INTEGER,
            video_duration INTEGER,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await ensureColumn("donations", "video_url", "TEXT");
    await ensureColumn("donations", "video_id", "TEXT");
    await ensureColumn("donations", "video_start", "INTEGER");
    await ensureColumn("donations", "video_duration", "INTEGER");

    await dbRun(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    `);

    await dbRun(`
        CREATE TABLE IF NOT EXISTS mobile_sessions (
            session_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            message TEXT,
            amount NUMERIC(12,2) NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at BIGINT NOT NULL,
            expires_at BIGINT NOT NULL,
            verified_at BIGINT,
            trans_ref TEXT,
            custom_sound_token TEXT,
            video_url TEXT,
            video_id TEXT,
            video_start INTEGER,
            video_duration INTEGER
        )
    `);

    await ensureColumn("mobile_sessions", "custom_sound_token", "TEXT");
    await ensureColumn("mobile_sessions", "video_url", "TEXT");
    await ensureColumn("mobile_sessions", "video_id", "TEXT");
    await ensureColumn("mobile_sessions", "video_start", "INTEGER");
    await ensureColumn("mobile_sessions", "video_duration", "INTEGER");

    await dbRun(`
        CREATE INDEX IF NOT EXISTS
        idx_mobile_sessions_expires_at
        ON mobile_sessions (expires_at)
    `);

    await dbRun(`
        CREATE INDEX IF NOT EXISTS
        idx_mobile_sessions_status
        ON mobile_sessions (status)
    `);

    await dbRun(`
        CREATE TABLE IF NOT EXISTS custom_sounds (
            token TEXT PRIMARY KEY,
            file_name TEXT NOT NULL,
            original_name TEXT,
            mime_type TEXT NOT NULL,
            size INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at BIGINT NOT NULL,
            expires_at BIGINT NOT NULL,
            used_at BIGINT
        )
    `);

    await dbRun(`
        CREATE INDEX IF NOT EXISTS
        idx_custom_sounds_expires_at
        ON custom_sounds (expires_at)
    `);

    for (const [key, value] of Object.entries(defaultSettings)) {
        await dbRun(
            `
            INSERT INTO settings
            (
                key,
                value
            )
            VALUES (?, ?)
            ON CONFLICT(key)
            DO NOTHING
            `,
            [key, value]
        );
    }
}

async function getSettings() {
    const rows = await dbAll(`
        SELECT
            key,
            value
        FROM settings
    `);

    const settings = {
        ...defaultSettings
    };

    for (const row of rows) {
        settings[row.key] = row.value;
    }

    return settings;
}

async function setSetting(key, value) {
    await dbRun(
        `
        INSERT INTO settings
        (
            key,
            value
        )
        VALUES (?, ?)
        ON CONFLICT(key)
        DO UPDATE SET
            value = EXCLUDED.value
        `,
        [key, String(value)]
    );
}

function toBoolean(value) {
    return (
        value === true ||
        value === 1 ||
        value === "1" ||
        value === "true"
    );
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function normalizeVolumeValue(value, fallback) {
    if (value === undefined || value === null || value === "") {
        return clamp(Math.round(Number(fallback) || 0), 0, 100);
    }

    const number = Number(value);

    if (!Number.isFinite(number) || number < 0 || number > 100) {
        throw new Error("Volume ต้องอยู่ระหว่าง 0 - 100");
    }

    return Math.round(number);
}

async function getAlertSettings() {
    const s = await getSettings();

    const numberOr = (value, fallback) => {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    };

    return {
        ttsEnabled: s.alert_tts_enabled === "1",
        readMessage: s.alert_read_message === "1",
        ttsRate: numberOr(s.alert_tts_rate, 1),
        bigAmount: numberOr(s.alert_big_amount, 500),
        megaAmount: numberOr(s.alert_mega_amount, 1000),
        afterTtsDelay: numberOr(s.alert_after_tts_delay, 1000),
        noTtsDisplayTime: numberOr(
            s.alert_no_tts_display_time,
            4500
        ),
        alertVolume: clamp(
            numberOr(s.alert_sound_volume, 70),
            0,
            100
        ),
        customSoundVolume: clamp(
            numberOr(s.alert_custom_sound_volume, 70),
            0,
            100
        ),
        ttsVolume: clamp(
            numberOr(s.alert_tts_volume, 100),
            0,
            100
        ),
        videoVolume: clamp(
            numberOr(s.alert_video_volume, 80),
            0,
            100
        ),
        masterVolume: clamp(
            numberOr(s.alert_master_volume, 100),
            0,
            100
        ),
        alertMuted: s.alert_sound_muted === "1",
        customSoundMuted: s.alert_custom_sound_muted === "1",
        ttsMuted: s.alert_tts_muted === "1",
        videoMuted: s.alert_video_muted === "1",
        ttsPitch: clamp(
            numberOr(s.alert_tts_pitch, 1),
            0.5,
            2
        ),
        ttsVoiceURI: String(
            s.alert_tts_voice_uri || "auto"
        ),
        ttsVoiceName: String(
            s.alert_tts_voice_name || ""
        ),
        ttsLang: String(
            s.alert_tts_lang || "th-TH"
        )
    };
}

async function emitAlertSettingsUpdate() {
    try {
        io.emit(
            "alert-settings-update",
            await getAlertSettings()
        );
    } catch (error) {
        console.error(
            "Emit Alert Settings Error:",
            error
        );
    }
}

async function getAllDonationTotal() {
    const row = await dbGet(`
        SELECT
            COALESCE(SUM(amount), 0) AS total
        FROM donations
    `);

    return Number(row?.total || 0);
}

async function getTopDonorsFromDB() {
    const rows = await dbAll(`
        SELECT
            name,
            SUM(amount) AS amount
        FROM donations
        GROUP BY name
        ORDER BY amount DESC
        LIMIT 3
    `);

    return rows.map(row => ({
        name: row.name,
        amount: Number(row.amount || 0)
    }));
}

async function getDonationGoal() {
    const settings = await getSettings();
    const allTimeTotal = await getAllDonationTotal();

    const target = Math.max(
        1,
        Number(settings.goal_target || 5000)
    );

    const baseTotal = Math.max(
        0,
        Number(settings.goal_base_total || 0)
    );

    const total = Math.max(
        0,
        allTimeTotal - baseTotal
    );

    const percent = Math.min(
        100,
        Math.max(
            0,
            Math.round((total / target) * 100)
        )
    );

    return {
        title:
            settings.goal_title ||
            "เป้าหมายสนับสนุน",
        target,
        total,
        percent,
        enabled: settings.goal_enabled === "1"
    };
}

async function emitGoalUpdate() {
    io.emit(
        "goal-update",
        await getDonationGoal()
    );
}

function requireAdminKey(req, res, next) {
    const expected = String(
        process.env.ADMIN_KEY || ""
    ).trim();

    const received = String(
        req.headers["x-admin-key"] || ""
    ).trim();

    if (!expected) {
        return res.status(500).json({
            success: false,
            message:
                "ยังไม่ได้ตั้ง ADMIN_KEY ใน .env"
        });
    }

    if (received !== expected) {
        return res.status(401).json({
            success: false,
            message: "Admin Key ไม่ถูกต้อง"
        });
    }

    next();
}

io.on("connection", socket => {
    console.log(
        "Client connected:",
        socket.id
    );

    socket.on("disconnect", () => {
        console.log(
            "Client disconnected:",
            socket.id
        );
    });
});

const upload = multer({
    storage: multer.memoryStorage(),

    limits: {
        fileSize: 4 * 1024 * 1024
    },

    fileFilter(req, file, callback) {
        const allowed = [
            "image/jpeg",
            "image/png",
            "image/webp"
        ];

        if (!allowed.includes(file.mimetype)) {
            return callback(
                new Error(
                    "รองรับสลิปเฉพาะ JPG, PNG และ WEBP"
                )
            );
        }

        callback(null, true);
    }
});

const audioUpload = multer({
    storage: multer.memoryStorage(),

    limits: {
        fileSize: CUSTOM_SOUND_MAX_BYTES
    },

    fileFilter(req, file, callback) {
        const allowed = [
            "audio/mpeg",
            "audio/mp3",
            "audio/wav",
            "audio/x-wav",
            "audio/ogg",
            "application/ogg"
        ];

        if (!allowed.includes(file.mimetype)) {
            return callback(
                new Error(
                    "รองรับเสียงเฉพาะ MP3, WAV และ OGG"
                )
            );
        }

        callback(null, true);
    }
});

async function verifySlipWithEasySlip(file, amount) {
    const apiKey = String(
        process.env.EASYSLIP_API_KEY || ""
    ).trim();

    if (!apiKey) {
        throw new Error(
            "ยังไม่ได้ตั้ง EASYSLIP_API_KEY"
        );
    }

    const form = new FormData();

    const blob = new Blob(
        [file.buffer],
        {
            type: file.mimetype
        }
    );

    form.append(
        "image",
        blob,
        file.originalname
    );

    form.append(
        "checkDuplicate",
        "true"
    );

    form.append(
        "matchAmount",
        String(amount)
    );

    form.append(
        "matchAccount",
        "true"
    );

    const response = await fetch(
        "https://api.easyslip.com/v2/verify/bank",
        {
            method: "POST",

            headers: {
                Authorization:
                    `Bearer ${apiKey}`
            },

            body: form
        }
    );

    let data;

    try {
        data = await response.json();
    } catch {
        throw new Error(
            "EasySlip ตอบกลับผิดรูปแบบ"
        );
    }

    console.log(
        "EasySlip HTTP:",
        response.status
    );

    if (!response.ok || !data.success) {
        throw new Error(
            data.error?.message ||
            data.message ||
            "ตรวจสอบสลิปไม่สำเร็จ"
        );
    }

    if (data.data?.isDuplicate === true) {
        throw new Error(
            "สลิปนี้ถูกใช้ไปแล้ว ไม่สามารถใช้ซ้ำได้"
        );
    }

    if (!data.data?.matchedAccount) {
        throw new Error(
            "บัญชีผู้รับไม่ถูกต้อง กรุณาโอนเข้าบัญชีที่กำหนด"
        );
    }

    if (data.data?.isAmountMatched !== true) {
        throw new Error(
            "ยอดเงินในสลิปไม่ตรงกับยอดโดเนท"
        );
    }

    return data;
}

function parseYouTubeVideoUrl(value) {
    let rawUrl = String(value || "").trim();

    if (!rawUrl) {
        return null;
    }

    if (!/^https?:\/\//i.test(rawUrl)) {
        rawUrl = "https://" + rawUrl;
    }

    let url;

    try {
        url = new URL(rawUrl);
    } catch {
        throw new Error(
            "ลิงก์วิดีโอไม่ถูกต้อง"
        );
    }

    const hostname = url.hostname
        .toLowerCase()
        .replace(/^www\./, "");

    let videoId = null;

    if (hostname === "youtu.be") {
        videoId =
            url.pathname
                .split("/")
                .filter(Boolean)[0] ||
            null;
    }

    if (
        [
            "youtube.com",
            "m.youtube.com",
            "music.youtube.com"
        ].includes(hostname)
    ) {
        if (url.pathname === "/watch") {
            videoId =
                url.searchParams.get("v");
        } else if (
            /^\/(shorts|embed|live)\//.test(
                url.pathname
            )
        ) {
            videoId =
                url.pathname
                    .split("/")
                    .filter(Boolean)[1] ||
                null;
        }
    }

    if (
        !videoId ||
        !/^[A-Za-z0-9_-]{11}$/.test(videoId)
    ) {
        throw new Error(
            "รองรับเฉพาะลิงก์ YouTube / youtu.be ที่ถูกต้อง"
        );
    }

    return {
        videoId,
        videoUrl:
            `https://www.youtube.com/watch?v=${videoId}`
    };
}

function parseVideoStart(value) {
    const raw = String(value ?? "").trim();

    if (!raw) {
        return 0;
    }

    if (/^\d+$/.test(raw)) {
        return Math.min(
            Math.max(0, Number(raw)),
            VIDEO_DONATION_MAX_START
        );
    }

    if (
        /^\d{1,2}:\d{1,2}(:\d{1,2})?$/.test(
            raw
        )
    ) {
        const parts = raw.split(":").map(Number);

        let seconds = 0;

        if (parts.length === 2) {
            if (parts[1] > 59) {
                throw new Error(
                    "วินาทีต้องไม่เกิน 59"
                );
            }

            seconds =
                parts[0] * 60 +
                parts[1];
        } else {
            if (
                parts[1] > 59 ||
                parts[2] > 59
            ) {
                throw new Error(
                    "นาทีหรือวินาทีไม่ถูกต้อง"
                );
            }

            seconds =
                parts[0] * 3600 +
                parts[1] * 60 +
                parts[2];
        }

        return Math.min(
            Math.max(0, seconds),
            VIDEO_DONATION_MAX_START
        );
    }

    throw new Error(
        "เวลาเริ่มใช้รูปแบบ 00:00 หรือ 01:25"
    );
}

function normalizeVideoDonation(
    body = {},
    amount = 0
) {
    const rawUrl = String(
        body.videoUrl ||
        body.video_url ||
        ""
    ).trim();

    if (!rawUrl) {
        return {
            videoUrl: null,
            videoId: null,
            videoStart: null,
            videoDuration: null
        };
    }

    if (
        Number(amount) <
        VIDEO_DONATION_MIN_AMOUNT
    ) {
        throw new Error(
            `แนบวิดีโอได้เมื่อสนับสนุนตั้งแต่ ${VIDEO_DONATION_MIN_AMOUNT} บาท`
        );
    }

    const video =
        parseYouTubeVideoUrl(rawUrl);

    const videoStart =
        parseVideoStart(
            body.videoStart ??
            body.video_start ??
            0
        );

    let videoDuration = Number.parseInt(
        body.videoDuration ??
        body.video_duration ??
        VIDEO_DONATION_MAX_DURATION,
        10
    );

    if (
        !Number.isFinite(videoDuration) ||
        videoDuration <= 0
    ) {
        videoDuration =
            VIDEO_DONATION_MAX_DURATION;
    }

    videoDuration = Math.min(
        Math.max(1, videoDuration),
        VIDEO_DONATION_MAX_DURATION
    );

    return {
        videoUrl: video.videoUrl,
        videoId: video.videoId,
        videoStart,
        videoDuration
    };
}

function validateDonationInput(body = {}) {
    const amount = Number(body.amount);

    let name =
        String(
            body.name || "Anonymous"
        ).trim() || "Anonymous";

    const message = String(
        body.message || ""
    ).trim();

    if (
        !Number.isFinite(amount) ||
        amount < 10
    ) {
        throw new Error(
            "สนับสนุนขั้นต่ำ 10 บาท"
        );
    }

    if (name.length > 30) {
        throw new Error(
            "ชื่อต้องไม่เกิน 30 ตัวอักษร"
        );
    }

    if (message.length > 200) {
        throw new Error(
            "ข้อความต้องไม่เกิน 200 ตัวอักษร"
        );
    }

    return {
        amount,
        name,
        message,
        ...normalizeVideoDonation(
            body,
            amount
        )
    };
}

function normalizeDonationFromEasySlip(
    input,
    data
) {
    const amountInSlip = Number(
        data.data?.amountInSlip
    );

    if (!Number.isFinite(amountInSlip)) {
        throw new Error(
            "ไม่พบยอดเงินในสลิป"
        );
    }

    if (
        input.videoId &&
        amountInSlip <
            VIDEO_DONATION_MIN_AMOUNT
    ) {
        throw new Error(
            `แนบวิดีโอได้เมื่อสนับสนุนตั้งแต่ ${VIDEO_DONATION_MIN_AMOUNT} บาท`
        );
    }

    return {
        name: input.name,
        message: input.message,
        amount: amountInSlip,

        transRef:
            data.data?.rawSlip?.transRef ||
            data.data?.transRef ||
            null,

        videoUrl:
            input.videoUrl || null,

        videoId:
            input.videoId || null,

        videoStart:
            input.videoId
                ? Math.min(
                      Math.max(
                          0,
                          Number(
                              input.videoStart ||
                                  0
                          )
                      ),
                      VIDEO_DONATION_MAX_START
                  )
                : null,

        videoDuration:
            input.videoId
                ? Math.min(
                      Math.max(
                          1,
                          Number(
                              input.videoDuration ||
                                  VIDEO_DONATION_MAX_DURATION
                          )
                      ),
                      VIDEO_DONATION_MAX_DURATION
                  )
                : null
    };
}

function getDonationTierSound(amount) {
    const value = Number(amount) || 0;

    if (value >= 1000) {
        return {
            soundTier: "mega",
            soundUrl:
                "/sounds/alert5.mp3"
        };
    }

    if (value >= 500) {
        return {
            soundTier: "500-999",
            soundUrl:
                "/sounds/alert5.mp3"
        };
    }

    if (value >= 300) {
        return {
            soundTier: "300-499",
            soundUrl:
                "/sounds/alert4.mp3"
        };
    }

    if (value >= 100) {
        return {
            soundTier: "100-299",
            soundUrl:
                "/sounds/alert3.mp3"
        };
    }

    if (value >= 50) {
        return {
            soundTier: "50-99",
            soundUrl:
                "/sounds/alert2.mp3"
        };
    }

    return {
        soundTier: "10-49",
        soundUrl:
            "/sounds/alert.mp3"
    };
}

function createCustomSoundToken() {
    return (
        "snd_" +
        crypto
            .randomBytes(24)
            .toString("hex")
    );
}

function createCustomSoundFileId() {
    return crypto
        .randomBytes(24)
        .toString("hex");
}

function normalizeCustomSoundToken(value) {
    const token =
        String(value || "").trim();

    return /^snd_[a-f0-9]{48}$/.test(
        token
    )
        ? token
        : null;
}

function getAudioExtension(mimeType) {
    switch (mimeType) {
        case "audio/mpeg":
        case "audio/mp3":
            return ".mp3";

        case "audio/wav":
        case "audio/x-wav":
            return ".wav";

        case "audio/ogg":
        case "application/ogg":
            return ".ogg";

        default:
            return null;
    }
}

async function getCustomSoundRecord(token) {
    const safeToken =
        normalizeCustomSoundToken(token);

    if (!safeToken) {
        return null;
    }

    return dbGet(
        `
        SELECT
            token,
            file_name,
            original_name,
            mime_type,
            size,
            status,
            created_at,
            expires_at,
            used_at
        FROM custom_sounds
        WHERE token = ?
        `,
        [safeToken]
    );
}

async function customSoundIsUsable(
    token,
    amount
) {
    if (
        Number(amount) <
        CUSTOM_SOUND_MIN_AMOUNT
    ) {
        return false;
    }

    const record =
        await getCustomSoundRecord(token);

    if (!record) {
        return false;
    }

    if (
        Number(record.expires_at) <=
        Date.now()
    ) {
        return false;
    }

    if (
        !["pending", "used"].includes(
            record.status
        )
    ) {
        return false;
    }

    try {
        await fs.promises.access(
            path.join(
                CUSTOM_SOUND_DIR,
                record.file_name
            ),
            fs.constants.R_OK
        );

        return true;
    } catch {
        return false;
    }
}

async function resolveDonationSound(
    amount,
    customSoundToken
) {
    const tier =
        getDonationTierSound(amount);

    const token =
        normalizeCustomSoundToken(
            customSoundToken
        );

    if (
        !token ||
        Number(amount) <
            CUSTOM_SOUND_MIN_AMOUNT
    ) {
        return {
            ...tier,
            customSound: false,
            soundToken: null
        };
    }

    if (
        !(await customSoundIsUsable(
            token,
            amount
        ))
    ) {
        console.warn(
            "Custom Sound ใช้ไม่ได้/หมดอายุ -> fallback tier sound"
        );

        return {
            ...tier,
            customSound: false,
            soundToken: null
        };
    }

    return {
        soundTier: "custom",

        soundUrl:
            `/api/custom-sound/${encodeURIComponent(
                token
            )}/audio`,

        customSound: true,
        soundToken: token
    };
}

async function markCustomSoundUsed(token) {
    const safeToken =
        normalizeCustomSoundToken(token);

    if (!safeToken) {
        return;
    }

    const now = Date.now();

    const keepUntil =
        now +
        CUSTOM_SOUND_AFTER_USE_TTL_MS;

    await dbRun(
        `
        UPDATE custom_sounds
        SET
            status = 'used',
            used_at = ?,
            expires_at =
                CASE
                    WHEN expires_at < ?
                    THEN ?
                    ELSE expires_at
                END
        WHERE token = ?
        `,
        [
            now,
            keepUntil,
            keepUntil,
            safeToken
        ]
    );
}

async function saveUploadedCustomSound(
    file,
    amount
) {
    if (!file) {
        throw new Error(
            "กรุณาเลือกไฟล์เสียง"
        );
    }

    const expectedAmount =
        Number(amount);

    if (
        !Number.isFinite(expectedAmount) ||
        expectedAmount <
            CUSTOM_SOUND_MIN_AMOUNT
    ) {
        throw new Error(
            `Custom Sound ใช้ได้เมื่อโดเนท ${CUSTOM_SOUND_MIN_AMOUNT} บาทขึ้นไป`
        );
    }

    const extension =
        getAudioExtension(file.mimetype);

    if (!extension) {
        throw new Error(
            "รองรับเสียงเฉพาะ MP3, WAV และ OGG"
        );
    }

    const token =
        createCustomSoundToken();

    const fileName =
        createCustomSoundFileId() +
        extension;

    const filePath =
        path.join(
            CUSTOM_SOUND_DIR,
            fileName
        );

    const createdAt = Date.now();

    const expiresAt =
        createdAt +
        CUSTOM_SOUND_TTL_MS;

    await fs.promises.writeFile(
        filePath,
        file.buffer,
        {
            flag: "wx"
        }
    );

    try {
        await dbRun(
            `
            INSERT INTO custom_sounds
            (
                token,
                file_name,
                original_name,
                mime_type,
                size,
                status,
                created_at,
                expires_at,
                used_at
            )
            VALUES
            (
                ?,
                ?,
                ?,
                ?,
                ?,
                'pending',
                ?,
                ?,
                NULL
            )
            `,
            [
                token,
                fileName,
                String(
                    file.originalname ||
                        "sound"
                ).slice(0, 160),
                file.mimetype,
                Number(
                    file.size ||
                        file.buffer.length ||
                        0
                ),
                createdAt,
                expiresAt
            ]
        );
    } catch (error) {
        await fs.promises
            .unlink(filePath)
            .catch(() => {});

        throw error;
    }

    return {
        token,
        expiresAt,
        maxPlaybackSeconds: 10
    };
}

async function cleanupCustomSounds() {
    try {
        const now = Date.now();

        const expired = await dbAll(
            `
            SELECT
                token,
                file_name
            FROM custom_sounds
            WHERE expires_at <= ?
            `,
            [now]
        );

        for (const item of expired) {
            await fs.promises
                .unlink(
                    path.join(
                        CUSTOM_SOUND_DIR,
                        item.file_name
                    )
                )
                .catch(() => {});
        }

        if (expired.length) {
            await dbRun(
                `
                DELETE FROM custom_sounds
                WHERE expires_at <= ?
                `,
                [now]
            );

            console.log(
                `🧹 Custom Sounds cleaned: ${expired.length}`
            );
        }
    } catch (error) {
        console.error(
            "Custom Sound Cleanup:",
            error
        );
    }
}

async function saveDonation(donation) {
    if (!donation.transRef) {
        throw new Error(
            "ไม่พบเลขอ้างอิงธุรกรรมในสลิป"
        );
    }

    try {
        const result = await dbRun(
            `
            INSERT INTO donations
            (
                name,
                message,
                amount,
                trans_ref,
                video_url,
                video_id,
                video_start,
                video_duration
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
            `,
            [
                donation.name,
                donation.message,
                donation.amount,
                donation.transRef,
                donation.videoUrl || null,
                donation.videoId || null,
                donation.videoId
                    ? Number(
                          donation.videoStart ||
                              0
                      )
                    : null,
                donation.videoId
                    ? Math.min(
                          Number(
                              donation.videoDuration ||
                                  VIDEO_DONATION_MAX_DURATION
                          ),
                          VIDEO_DONATION_MAX_DURATION
                      )
                    : null
            ]
        );

        console.log(
            "Donation saved ID:",
            result.lastID
        );

        return result;
    } catch (error) {
        if (
            error?.code === "23505" ||
            String(error.message).includes(
                "duplicate key value violates unique constraint"
            )
        ) {
            throw new Error(
                "รายการนี้ถูกบันทึกไปแล้ว"
            );
        }

        throw error;
    }
}

async function broadcastDonation(donation) {
    io.emit("donation", donation);

    io.emit(
        "ranking-update",
        await getTopDonorsFromDB()
    );

    await emitGoalUpdate();
}

function generateMobileSessionId() {
    return (
        "mob_" +
        crypto
            .randomBytes(24)
            .toString("hex")
    );
}

async function createMobileSessionDB(
    session
) {
    await dbRun(
        `
        INSERT INTO mobile_sessions
        (
            session_id,
            name,
            message,
            amount,
            status,
            created_at,
            expires_at,
            verified_at,
            trans_ref,
            custom_sound_token,
            video_url,
            video_id,
            video_start,
            video_duration
        )
        VALUES
        (
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            NULL,
            NULL,
            ?,
            ?,
            ?,
            ?,
            ?
        )
        `,
        [
            session.sessionId,
            session.name,
            session.message,
            session.amount,
            session.status,
            session.createdAt,
            session.expiresAt,
            session.customSoundToken ||
                null,
            session.videoUrl || null,
            session.videoId || null,
            session.videoId
                ? Number(
                      session.videoStart || 0
                  )
                : null,
            session.videoId
                ? Math.min(
                      Number(
                          session.videoDuration ||
                              VIDEO_DONATION_MAX_DURATION
                      ),
                      VIDEO_DONATION_MAX_DURATION
                  )
                : null
        ]
    );

    return session;
}

async function getMobileSessionDB(
    sessionId
) {
    const row = await dbGet(
        `
        SELECT
            session_id,
            name,
            message,
            amount,
            status,
            created_at,
            expires_at,
            verified_at,
            trans_ref,
            custom_sound_token,
            video_url,
            video_id,
            video_start,
            video_duration
        FROM mobile_sessions
        WHERE session_id = ?
        `,
        [sessionId]
    );

    if (!row) {
        return null;
    }

    return {
        sessionId: row.session_id,
        name: row.name,
        message: row.message || "",
        amount: Number(row.amount),
        status: row.status,
        createdAt: Number(row.created_at),
        expiresAt: Number(row.expires_at),

        verifiedAt: row.verified_at
            ? Number(row.verified_at)
            : null,

        transRef:
            row.trans_ref || null,

        customSoundToken:
            row.custom_sound_token ||
            null,

        videoUrl:
            row.video_url || null,

        videoId:
            row.video_id || null,

        videoStart: row.video_id
            ? Number(row.video_start || 0)
            : null,

        videoDuration: row.video_id
            ? Math.min(
                  Number(
                      row.video_duration ||
                          VIDEO_DONATION_MAX_DURATION
                  ),
                  VIDEO_DONATION_MAX_DURATION
              )
            : null
    };
}

async function deleteMobileSessionDB(
    sessionId
) {
    await dbRun(
        `
        DELETE FROM mobile_sessions
        WHERE session_id = ?
        `,
        [sessionId]
    );
}

async function lockMobileSession(sessionId) {
    const result = await dbRun(
        `
        UPDATE mobile_sessions
        SET
            status = 'verifying'
        WHERE
            session_id = ?
            AND status = 'pending'
            AND expires_at > ?
        `,
        [sessionId, Date.now()]
    );

    return result.changes === 1;
}

async function resetMobileSession(
    sessionId
) {
    await dbRun(
        `
        UPDATE mobile_sessions
        SET
            status = 'pending'
        WHERE
            session_id = ?
            AND status = 'verifying'
            AND expires_at > ?
        `,
        [sessionId, Date.now()]
    );
}

async function saveMobileDonationAndComplete(
    sessionId,
    donation
) {
    const client =
        await pool.connect();

    try {
        await client.query("BEGIN");

        const insertResult = await dbRun(
            `
            INSERT INTO donations
            (
                name,
                message,
                amount,
                trans_ref,
                video_url,
                video_id,
                video_start,
                video_duration
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
            `,
            [
                donation.name,
                donation.message,
                donation.amount,
                donation.transRef,
                donation.videoUrl || null,
                donation.videoId || null,
                donation.videoId
                    ? Number(
                          donation.videoStart ||
                              0
                      )
                    : null,
                donation.videoId
                    ? Math.min(
                          Number(
                              donation.videoDuration ||
                                  VIDEO_DONATION_MAX_DURATION
                          ),
                          VIDEO_DONATION_MAX_DURATION
                      )
                    : null
            ],
            client
        );

        const updateResult =
            await dbRun(
                `
                UPDATE mobile_sessions
                SET
                    status = 'verified',
                    verified_at = ?,
                    trans_ref = ?
                WHERE
                    session_id = ?
                    AND status = 'verifying'
                `,
                [
                    Date.now(),
                    donation.transRef,
                    sessionId
                ],
                client
            );

        if (updateResult.changes !== 1) {
            throw new Error(
                "ไม่สามารถยืนยัน Mobile Session ได้"
            );
        }

        await client.query("COMMIT");

        return insertResult;
    } catch (error) {
        await client
            .query("ROLLBACK")
            .catch(() => {});

        if (
            error?.code === "23505" ||
            String(error.message).includes(
                "duplicate key value violates unique constraint"
            )
        ) {
            throw new Error(
                "รายการนี้ถูกบันทึกไปแล้ว"
            );
        }

        throw error;
    } finally {
        client.release();
    }
}

async function cleanupMobileSessions() {
    try {
        const result = await dbRun(
            `
            DELETE FROM mobile_sessions
            WHERE expires_at <= ?
            `,
            [Date.now()]
        );

        if (result.changes > 0) {
            console.log(
                `🧹 Mobile Sessions cleaned: ${result.changes}`
            );
        }
    } catch (error) {
        console.error(
            "Mobile Session Cleanup:",
            error
        );
    }
}

async function recoverMobileSessions() {
    try {
        const result = await dbRun(
            `
            UPDATE mobile_sessions
            SET
                status = 'pending'
            WHERE
                status = 'verifying'
                AND expires_at > ?
            `,
            [Date.now()]
        );

        if (result.changes > 0) {
            console.log(
                `♻ Mobile Sessions recovered: ${result.changes}`
            );
        }
    } catch (error) {
        console.error(
            "Mobile Session Recovery:",
            error
        );
    }
}

function getPublicBaseUrl(req) {
    if (PUBLIC_BASE_URL) {
        return PUBLIC_BASE_URL;
    }

    const forwardedProto =
        String(
            req.headers[
                "x-forwarded-proto"
            ] || ""
        )
            .split(",")[0]
            .trim();

    const protocol =
        forwardedProto ||
        req.protocol ||
        "http";

    return `${protocol}://${req.get(
        "host"
    )}`;
}

app.post(
    "/api/custom-sound/upload",
    audioUpload.single("sound"),
    async (req, res) => {
        try {
            const result =
                await saveUploadedCustomSound(
                    req.file,
                    Number(req.body.amount)
                );

            res.json({
                success: true,
                message:
                    "อัปโหลด Custom Sound แล้ว",
                customSound: result
            });
        } catch (error) {
            console.error(
                "Custom Sound Upload Error:",
                error
            );

            res.status(400).json({
                success: false,
                message:
                    error.message ||
                    "อัปโหลดเสียงไม่สำเร็จ"
            });
        }
    }
);

app.get(
    "/api/custom-sound/:token/audio",
    async (req, res) => {
        try {
            const token =
                normalizeCustomSoundToken(
                    req.params.token
                );

            if (!token) {
                return res
                    .status(404)
                    .end();
            }

            const record =
                await getCustomSoundRecord(
                    token
                );

            if (
                !record ||
                Number(
                    record.expires_at
                ) <= Date.now()
            ) {
                return res
                    .status(404)
                    .end();
            }

            const filePath =
                path.join(
                    CUSTOM_SOUND_DIR,
                    record.file_name
                );

            await fs.promises.access(
                filePath,
                fs.constants.R_OK
            );

            res.set(
                "Cache-Control",
                "no-store"
            );

            res.type(record.mime_type);
            res.sendFile(filePath);
        } catch (error) {
            console.error(
                "Custom Sound Stream Error:",
                error
            );

            res.status(404).end();
        }
    }
);

app.get(
    "/generate-qr/:amount",
    async (req, res) => {
        try {
            const amount = Number(
                req.params.amount
            );

            if (
                !Number.isFinite(amount) ||
                amount < 10
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "ยอดสนับสนุนขั้นต่ำ 10 บาท"
                    });
            }

            const promptpayID =
                String(
                    process.env
                        .PROMPTPAY_ID ||
                        ""
                ).trim();

            if (!promptpayID) {
                return res
                    .status(500)
                    .json({
                        success: false,
                        message:
                            "ยังไม่ได้ตั้ง PROMPTPAY_ID"
                    });
            }

            const payload =
                generatePayload(
                    promptpayID,
                    { amount }
                );

            const qr =
                await QRCode.toDataURL(
                    payload
                );

            res.json({
                success: true,
                qr,
                amount
            });
        } catch (error) {
            console.error(
                "QR ERROR:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "สร้าง QR ไม่สำเร็จ"
            });
        }
    }
);

app.post(
    "/verify-slip",
    upload.single("slip"),
    async (req, res) => {
        try {
            if (!req.file) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "กรุณาอัปโหลดสลิป"
                    });
            }

            const input =
                validateDonationInput(
                    req.body
                );

            const data =
                await verifySlipWithEasySlip(
                    req.file,
                    input.amount
                );

            const donation =
                normalizeDonationFromEasySlip(
                    input,
                    data
                );

            Object.assign(
                donation,
                await resolveDonationSound(
                    donation.amount,
                    req.body
                        .customSoundToken
                )
            );

            await saveDonation(donation);

            if (
                donation.customSound &&
                donation.soundToken
            ) {
                await markCustomSoundUsed(
                    donation.soundToken
                ).catch(error =>
                    console.error(
                        "Mark Custom Sound Used Error:",
                        error
                    )
                );
            }

            await broadcastDonation(
                donation
            );

            res.json({
                success: true,
                message:
                    "ตรวจสอบสลิปสำเร็จ",
                donation,
                data: data.data
            });
        } catch (error) {
            console.error(
                "VERIFY ERROR:",
                error
            );

            res.status(400).json({
                success: false,
                message:
                    error.message ||
                    "ตรวจสอบสลิปไม่สำเร็จ"
            });
        }
    }
);

app.get(
    "/top-donors",
    async (req, res) => {
        try {
            res.json({
                success: true,
                donors:
                    await getTopDonorsFromDB()
            });
        } catch (error) {
            console.error(
                "Top Donors Error:",
                error
            );

            res.status(500).json({
                success: false,
                donors: [],
                message:
                    "โหลดอันดับไม่สำเร็จ"
            });
        }
    }
);

app.get(
    "/api/goal",
    async (req, res) => {
        try {
            res.json({
                success: true,
                ...(await getDonationGoal())
            });
        } catch (error) {
            console.error(
                "Public Goal Error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "โหลด Goal ไม่สำเร็จ"
            });
        }
    }
);

app.get(
    "/api/admin/goal",
    requireAdminKey,
    async (req, res) => {
        try {
            res.json({
                success: true,
                goal:
                    await getDonationGoal()
            });
        } catch (error) {
            console.error(
                "Admin Get Goal:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "โหลด Goal ไม่สำเร็จ"
            });
        }
    }
);

app.post(
    "/api/admin/goal",
    requireAdminKey,
    async (req, res) => {
        try {
            const title = String(
                req.body.title ||
                    "เป้าหมายสนับสนุน"
            ).trim();

            const target = Number(
                req.body.target
            );

            const enabled =
                toBoolean(
                    req.body.enabled
                );

            if (
                !Number.isFinite(target) ||
                target <= 0
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "เป้าหมายต้องมากกว่า 0 บาท"
                    });
            }

            if (title.length > 60) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "ชื่อ Goal ต้องไม่เกิน 60 ตัวอักษร"
                    });
            }

            await Promise.all([
                setSetting(
                    "goal_title",
                    title ||
                        "เป้าหมายสนับสนุน"
                ),

                setSetting(
                    "goal_target",
                    target
                ),

                setSetting(
                    "goal_enabled",
                    enabled ? "1" : "0"
                )
            ]);

            const goal =
                await getDonationGoal();

            io.emit(
                "goal-update",
                goal
            );

            res.json({
                success: true,
                goal
            });
        } catch (error) {
            console.error(
                "Update Goal Error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "บันทึก Goal ไม่สำเร็จ"
            });
        }
    }
);

app.post(
    "/api/admin/goal/reset",
    requireAdminKey,
    async (req, res) => {
        try {
            await setSetting(
                "goal_base_total",
                await getAllDonationTotal()
            );

            const goal =
                await getDonationGoal();

            io.emit(
                "goal-update",
                goal
            );

            res.json({
                success: true,
                goal
            });
        } catch (error) {
            console.error(
                "Reset Goal Error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "รีเซ็ต Goal ไม่สำเร็จ"
            });
        }
    }
);

app.get(
    "/api/alert-settings",
    async (req, res) => {
        try {
            res.json({
                success: true,
                settings:
                    await getAlertSettings()
            });
        } catch (error) {
            console.error(
                "Get Alert Settings Error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "โหลด Alert Settings ไม่สำเร็จ"
            });
        }
    }
);

app.get(
    "/api/admin/alert-settings",
    requireAdminKey,
    async (req, res) => {
        try {
            res.json({
                success: true,
                settings:
                    await getAlertSettings()
            });
        } catch (error) {
            console.error(
                "Admin Get Alert Settings Error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "โหลด Alert Settings ไม่สำเร็จ"
            });
        }
    }
);

app.post(
    "/api/admin/alert-settings",
    requireAdminKey,
    async (req, res) => {
        try {
            const current =
                await getAlertSettings();

            const pickBool = (
                key,
                fallback
            ) =>
                req.body[key] ===
                undefined
                    ? fallback
                    : toBoolean(
                          req.body[key]
                      );

            const pickNum = (
                key,
                fallback
            ) =>
                req.body[key] ===
                undefined
                    ? fallback
                    : Number(
                          req.body[key]
                      );

            const ttsEnabled =
                pickBool(
                    "ttsEnabled",
                    current.ttsEnabled
                );

            const readMessage =
                pickBool(
                    "readMessage",
                    current.readMessage
                );

            const ttsRate =
                pickNum(
                    "ttsRate",
                    current.ttsRate
                );

            const bigAmount =
                pickNum(
                    "bigAmount",
                    current.bigAmount
                );

            const megaAmount =
                pickNum(
                    "megaAmount",
                    current.megaAmount
                );

            const afterTtsDelay =
                pickNum(
                    "afterTtsDelay",
                    current.afterTtsDelay
                );

            const noTtsDisplayTime =
                pickNum(
                    "noTtsDisplayTime",
                    current
                        .noTtsDisplayTime
                );

            const alertVolume =
                normalizeVolumeValue(
                    req.body.alertVolume,
                    current.alertVolume
                );

            const customSoundVolume =
                normalizeVolumeValue(
                    req.body
                        .customSoundVolume,
                    current
                        .customSoundVolume
                );

            const ttsVolume =
                normalizeVolumeValue(
                    req.body.ttsVolume,
                    current.ttsVolume
                );

            const videoVolume =
                normalizeVolumeValue(
                    req.body.videoVolume,
                    current.videoVolume
                );

            const masterVolume =
                normalizeVolumeValue(
                    req.body.masterVolume,
                    current.masterVolume
                );

            const alertMuted =
                pickBool(
                    "alertMuted",
                    current.alertMuted
                );

            const customSoundMuted =
                pickBool(
                    "customSoundMuted",
                    current
                        .customSoundMuted
                );

            const ttsMuted =
                pickBool(
                    "ttsMuted",
                    current.ttsMuted
                );

            const videoMuted =
                pickBool(
                    "videoMuted",
                    current.videoMuted
                );

            const ttsPitch =
                pickNum(
                    "ttsPitch",
                    current.ttsPitch
                );

            const ttsVoiceURI =
                req.body.ttsVoiceURI ===
                undefined
                    ? String(
                          current
                              .ttsVoiceURI ||
                              "auto"
                      )
                    : (
                          String(
                              req.body
                                  .ttsVoiceURI ||
                                  "auto"
                          )
                              .trim()
                              .slice(
                                  0,
                                  255
                              ) || "auto"
                      );

            const ttsVoiceName =
                req.body.ttsVoiceName ===
                undefined
                    ? String(
                          current
                              .ttsVoiceName ||
                              ""
                      )
                    : String(
                          req.body
                              .ttsVoiceName ||
                              ""
                      )
                          .trim()
                          .slice(
                              0,
                              255
                          );

            const ttsLang =
                req.body.ttsLang ===
                undefined
                    ? String(
                          current.ttsLang ||
                              "th-TH"
                      )
                    : (
                          String(
                              req.body
                                  .ttsLang ||
                                  "th-TH"
                          )
                              .trim()
                              .slice(
                                  0,
                                  40
                              ) || "th-TH"
                      );

            if (
                !Number.isFinite(
                    ttsRate
                ) ||
                ttsRate < 0.5 ||
                ttsRate > 2
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "ความเร็ว TTS ต้องอยู่ระหว่าง 0.5 - 2.0"
                    });
            }

            if (
                !Number.isFinite(
                    ttsPitch
                ) ||
                ttsPitch < 0.5 ||
                ttsPitch > 2
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Pitch TTS ต้องอยู่ระหว่าง 0.5 - 2.0"
                    });
            }

            if (
                !Number.isFinite(
                    bigAmount
                ) ||
                bigAmount <= 0
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "ยอด BIG Donation ต้องมากกว่า 0 บาท"
                    });
            }

            if (
                !Number.isFinite(
                    megaAmount
                ) ||
                megaAmount <= bigAmount
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "ยอด MEGA Donation ต้องมากกว่า BIG Donation"
                    });
            }

            if (
                !Number.isFinite(
                    afterTtsDelay
                ) ||
                afterTtsDelay < 0 ||
                afterTtsDelay > 10000
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "เวลาค้างหลัง TTS ต้องอยู่ระหว่าง 0 - 10 วินาที"
                    });
            }

            if (
                !Number.isFinite(
                    noTtsDisplayTime
                ) ||
                noTtsDisplayTime <
                    1000 ||
                noTtsDisplayTime >
                    30000
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "เวลาแสดง Alert ต้องอยู่ระหว่าง 1 - 30 วินาที"
                    });
            }

            await Promise.all([
                setSetting(
                    "alert_tts_enabled",
                    ttsEnabled ? "1" : "0"
                ),

                setSetting(
                    "alert_read_message",
                    readMessage
                        ? "1"
                        : "0"
                ),

                setSetting(
                    "alert_tts_rate",
                    ttsRate
                ),

                setSetting(
                    "alert_big_amount",
                    bigAmount
                ),

                setSetting(
                    "alert_mega_amount",
                    megaAmount
                ),

                setSetting(
                    "alert_after_tts_delay",
                    Math.round(
                        afterTtsDelay
                    )
                ),

                setSetting(
                    "alert_no_tts_display_time",
                    Math.round(
                        noTtsDisplayTime
                    )
                ),

                setSetting(
                    "alert_sound_volume",
                    alertVolume
                ),

                setSetting(
                    "alert_custom_sound_volume",
                    customSoundVolume
                ),

                setSetting(
                    "alert_tts_volume",
                    ttsVolume
                ),

                setSetting(
                    "alert_video_volume",
                    videoVolume
                ),

                setSetting(
                    "alert_master_volume",
                    masterVolume
                ),

                setSetting(
                    "alert_sound_muted",
                    alertMuted
                        ? "1"
                        : "0"
                ),

                setSetting(
                    "alert_custom_sound_muted",
                    customSoundMuted
                        ? "1"
                        : "0"
                ),

                setSetting(
                    "alert_tts_muted",
                    ttsMuted
                        ? "1"
                        : "0"
                ),

                setSetting(
                    "alert_video_muted",
                    videoMuted
                        ? "1"
                        : "0"
                ),

                setSetting(
                    "alert_tts_pitch",
                    ttsPitch
                ),

                setSetting(
                    "alert_tts_voice_uri",
                    ttsVoiceURI
                ),

                setSetting(
                    "alert_tts_voice_name",
                    ttsVoiceName
                ),

                setSetting(
                    "alert_tts_lang",
                    ttsLang
                )
            ]);

            const settings =
                await getAlertSettings();

            await emitAlertSettingsUpdate();

            res.json({
                success: true,
                message:
                    "บันทึก Alert Settings แล้ว",
                settings
            });
        } catch (error) {
            console.error(
                "Update Alert Settings Error:",
                error
            );

            res.status(400).json({
                success: false,
                message:
                    error.message ||
                    "บันทึก Alert Settings ไม่สำเร็จ"
            });
        }
    }
);

app.post(
    "/api/mobile-upload/create",
    async (req, res) => {
        try {
            const input =
                validateDonationInput(
                    req.body
                );

            const requestedToken =
                normalizeCustomSoundToken(
                    req.body
                        .customSoundToken
                );

            let customSoundToken =
                null;

            if (
                requestedToken &&
                input.amount >=
                    CUSTOM_SOUND_MIN_AMOUNT
            ) {
                if (
                    await customSoundIsUsable(
                        requestedToken,
                        input.amount
                    )
                ) {
                    customSoundToken =
                        requestedToken;
                }
            }

            const sessionId =
                generateMobileSessionId();

            const createdAt =
                Date.now();

            const expiresAt =
                createdAt +
                MOBILE_SESSION_TTL_MS;

            const session = {
                sessionId,
                name: input.name,
                message: input.message,
                amount: input.amount,
                status: "pending",
                createdAt,
                expiresAt,
                customSoundToken,
                videoUrl:
                    input.videoUrl,
                videoId:
                    input.videoId,
                videoStart:
                    input.videoStart,
                videoDuration:
                    input.videoDuration
            };

            await createMobileSessionDB(
                session
            );

            const uploadUrl =
                `${getPublicBaseUrl(
                    req
                )}/mobile-upload.html?session=${encodeURIComponent(
                    sessionId
                )}`;

            const qr =
                await QRCode.toDataURL(
                    uploadUrl
                );

            console.log(
                "📱 Mobile Session created:",
                sessionId
            );

            res.json({
                success: true,
                sessionId,
                uploadUrl,
                qr,
                expiresAt,

                customSoundAccepted:
                    Boolean(
                        customSoundToken
                    ),

                videoAccepted:
                    Boolean(
                        input.videoId
                    )
            });
        } catch (error) {
            console.error(
                "Create Mobile Session:",
                error
            );

            res.status(400).json({
                success: false,
                message:
                    error.message ||
                    "สร้าง Mobile Upload ไม่สำเร็จ"
            });
        }
    }
);

app.get(
    "/api/mobile-upload/session/:sessionId",
    async (req, res) => {
        try {
            const sessionId = String(
                req.params.sessionId || ""
            ).trim();

            const session =
                await getMobileSessionDB(
                    sessionId
                );

            if (!session) {
                return res
                    .status(404)
                    .json({
                        success: false,
                        message:
                            "ไม่พบ Session นี้ หรือ Session หมดอายุแล้ว"
                    });
            }

            if (
                Date.now() >
                session.expiresAt
            ) {
                await deleteMobileSessionDB(
                    sessionId
                );

                return res
                    .status(410)
                    .json({
                        success: false,
                        message:
                            "Session หมดอายุแล้ว"
                    });
            }

            res.json({
                success: true,

                session: {
                    sessionId:
                        session.sessionId,
                    name: session.name,
                    message:
                        session.message,
                    amount:
                        session.amount,
                    status:
                        session.status,
                    expiresAt:
                        session.expiresAt,

                    customSound:
                        Boolean(
                            session.customSoundToken
                        ),

                    video:
                        Boolean(
                            session.videoId
                        ),

                    videoUrl:
                        session.videoUrl,

                    videoId:
                        session.videoId,

                    videoStart:
                        session.videoStart,

                    videoDuration:
                        session.videoDuration
                }
            });
        } catch (error) {
            console.error(
                "Get Mobile Session:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "โหลด Mobile Session ไม่สำเร็จ"
            });
        }
    }
);

app.post(
    "/api/mobile-upload/verify/:sessionId",
    upload.single("slip"),
    async (req, res) => {
        let sessionId = null;
        let locked = false;

        try {
            sessionId = String(
                req.params.sessionId || ""
            ).trim();

            const session =
                await getMobileSessionDB(
                    sessionId
                );

            if (!session) {
                return res
                    .status(404)
                    .json({
                        success: false,
                        message:
                            "ไม่พบ Session นี้ หรือ Session หมดอายุแล้ว"
                    });
            }

            if (
                Date.now() >
                session.expiresAt
            ) {
                await deleteMobileSessionDB(
                    sessionId
                );

                return res
                    .status(410)
                    .json({
                        success: false,
                        message:
                            "Session หมดอายุแล้ว กรุณาสร้าง QR ใหม่"
                    });
            }

            if (
                session.status ===
                "verified"
            ) {
                return res
                    .status(409)
                    .json({
                        success: false,
                        message:
                            "Session นี้ถูกใช้งานสำเร็จไปแล้ว"
                    });
            }

            if (
                session.status ===
                "verifying"
            ) {
                return res
                    .status(409)
                    .json({
                        success: false,
                        message:
                            "กำลังตรวจสอบสลิปนี้อยู่ กรุณารอสักครู่"
                    });
            }

            if (!req.file) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "กรุณาเลือกสลิป"
                    });
            }

            locked =
                await lockMobileSession(
                    sessionId
                );

            if (!locked) {
                return res
                    .status(409)
                    .json({
                        success: false,
                        message:
                            "Session นี้กำลังถูกใช้งาน หรือไม่สามารถใช้งานได้แล้ว"
                    });
            }

            const data =
                await verifySlipWithEasySlip(
                    req.file,
                    session.amount
                );

            const donation =
                normalizeDonationFromEasySlip(
                    {
                        name:
                            session.name,
                        message:
                            session.message,
                        videoUrl:
                            session.videoUrl,
                        videoId:
                            session.videoId,
                        videoStart:
                            session.videoStart,
                        videoDuration:
                            session.videoDuration
                    },
                    data
                );

            Object.assign(
                donation,
                await resolveDonationSound(
                    donation.amount,
                    session
                        .customSoundToken
                )
            );

            await saveMobileDonationAndComplete(
                sessionId,
                donation
            );

            locked = false;

            if (
                donation.customSound &&
                donation.soundToken
            ) {
                await markCustomSoundUsed(
                    donation.soundToken
                ).catch(error =>
                    console.error(
                        "Mark Mobile Custom Sound Used Error:",
                        error
                    )
                );
            }

            await broadcastDonation(
                donation
            );

            io.emit(
                "mobile-slip-success",
                {
                    sessionId,
                    amount:
                        donation.amount,
                    name:
                        donation.name
                }
            );

            console.log(
                "✅ Mobile Session verified:",
                sessionId
            );

            res.json({
                success: true,
                message:
                    "ส่งสลิปจากมือถือสำเร็จ",
                donation
            });
        } catch (error) {
            console.error(
                "Mobile Verify Error:",
                error
            );

            if (
                locked &&
                sessionId
            ) {
                await resetMobileSession(
                    sessionId
                ).catch(
                    resetError =>
                        console.error(
                            "Reset Mobile Session Error:",
                            resetError
                        )
                );
            }

            res.status(400).json({
                success: false,
                message:
                    error.message ||
                    "ตรวจสอบสลิปไม่สำเร็จ"
            });
        }
    }
);

app.post(
    "/test-donation",
    requireAdminKey,
    (req, res) => {
        try {
            const name =
                String(
                    req.body?.name ||
                        "AMR29 Test"
                )
                    .trim()
                    .slice(0, 30) ||
                "AMR29 Test";

            const message =
                String(
                    req.body?.message ||
                        ""
                )
                    .trim()
                    .slice(0, 200);

            const amount =
                Number(
                    req.body?.amount
                );

            if (
                !Number.isFinite(amount) ||
                amount < 10
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "จำนวนเงิน Test ต้องตั้งแต่ 10 บาทขึ้นไป"
                    });
            }

            let video = {
                videoUrl: null,
                videoId: null,
                videoStart: null,
                videoDuration: null
            };

            if (
                String(
                    req.body?.videoUrl ||
                        ""
                ).trim()
            ) {
                video =
                    normalizeVideoDonation(
                        req.body,
                        amount
                    );
            }

            const donation = {
                name,
                message,
                amount,

                ...getDonationTierSound(
                    amount
                ),

                customSound: false,
                soundToken: null,

                ...video,

                isTest: true,
                test: true,
                createdAt: Date.now()
            };

            io.emit(
                "donation",
                donation
            );

            io.emit(
                "test-donation-preview",
                donation
            );

            console.log(
                "🧪 Test Donation:",
                `${donation.name} ${amount} บาท`
            );

            res.json({
                success: true,
                message:
                    "ส่ง Test Donation แล้ว",
                donation
            });
        } catch (error) {
            console.error(
                "Test Donation Error:",
                error
            );

            res.status(400).json({
                success: false,
                message:
                    error.message ||
                    "Test Donation ไม่สำเร็จ"
            });
        }
    }
);

app.post(
    "/api/admin/donation/:id/replay",
    requireAdminKey,
    async (req, res) => {
        try {
            const donationId =
                Number(req.params.id);

            if (
                !Number.isInteger(
                    donationId
                ) ||
                donationId <= 0
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Donation ID ไม่ถูกต้อง"
                    });
            }

            const donation =
                await dbGet(
                    `
                    SELECT
                        id,
                        name,
                        message,
                        amount,
                        video_url,
                        video_id,
                        video_start,
                        video_duration,
                        created_at
                    FROM donations
                    WHERE id = ?
                    `,
                    [donationId]
                );

            if (!donation) {
                return res
                    .status(404)
                    .json({
                        success: false,
                        message:
                            "ไม่พบ Donation นี้"
                    });
            }

            const replayDonation = {
                id: donation.id,
                name: donation.name,
                message:
                    donation.message ||
                    "",
                amount:
                    Number(
                        donation.amount ||
                            0
                    ),

                ...getDonationTierSound(
                    donation.amount
                ),

                customSound: false,
                soundToken: null,

                isReplay: true,
                replay: true,

                originalDonationId:
                    donation.id,

                videoUrl:
                    donation.video_url ||
                    null,

                videoId:
                    donation.video_id ||
                    null,

                videoStart:
                    donation.video_id
                        ? Number(
                              donation.video_start ||
                                  0
                          )
                        : null,

                videoDuration:
                    donation.video_id
                        ? Math.min(
                              Number(
                                  donation.video_duration ||
                                      VIDEO_DONATION_MAX_DURATION
                              ),
                              VIDEO_DONATION_MAX_DURATION
                          )
                        : null,

                createdAt: Date.now()
            };

            io.emit(
                "donation",
                replayDonation
            );

            res.json({
                success: true,
                message:
                    "เล่น Alert ซ้ำแล้ว",
                donation:
                    replayDonation
            });
        } catch (error) {
            console.error(
                "Replay Donation Error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    error.message ||
                    "Replay Alert ไม่สำเร็จ"
            });
        }
    }
);

app.get(
    "/api/dashboard",
    requireAdminKey,
    async (req, res) => {
        try {
            const [
                today,
                month,
                all,
                recent,
                topDonors,
                goal,
                alertSettings
            ] = await Promise.all([
                dbGet(`
                    SELECT
                        COUNT(*) AS count,
                        COALESCE(
                            SUM(amount),
                            0
                        ) AS total
                    FROM donations
                    WHERE
                        (
                            created_at
                            AT TIME ZONE
                            'Asia/Bangkok'
                        )::date
                        =
                        (
                            NOW()
                            AT TIME ZONE
                            'Asia/Bangkok'
                        )::date
                `),

                dbGet(`
                    SELECT
                        COUNT(*) AS count,
                        COALESCE(
                            SUM(amount),
                            0
                        ) AS total
                    FROM donations
                    WHERE
                        TO_CHAR(
                            created_at
                            AT TIME ZONE
                            'Asia/Bangkok',
                            'YYYY-MM'
                        )
                        =
                        TO_CHAR(
                            NOW()
                            AT TIME ZONE
                            'Asia/Bangkok',
                            'YYYY-MM'
                        )
                `),

                dbGet(`
                    SELECT
                        COUNT(*) AS count,
                        COALESCE(
                            SUM(amount),
                            0
                        ) AS total
                    FROM donations
                `),

                dbAll(`
                    SELECT
                        id,
                        name,
                        message,
                        amount,
                        video_url,
                        video_id,
                        video_start,
                        video_duration,
                        created_at
                    FROM donations
                    ORDER BY id DESC
                    LIMIT 12
                `),

                getTopDonorsFromDB(),
                getDonationGoal(),
                getAlertSettings()
            ]);

            const recentDonations =
                recent.map(row => ({
                    ...row,

                    amount:
                        Number(
                            row.amount ||
                                0
                        ),

                    videoUrl:
                        row.video_url ||
                        null,

                    videoId:
                        row.video_id ||
                        null,

                    videoStart:
                        row.video_id
                            ? Number(
                                  row.video_start ||
                                      0
                              )
                            : null,

                    videoDuration:
                        row.video_id
                            ? Math.min(
                                  Number(
                                      row.video_duration ||
                                          VIDEO_DONATION_MAX_DURATION
                                  ),
                                  VIDEO_DONATION_MAX_DURATION
                              )
                            : null
                }));

            res.json({
                success: true,

                stats: {
                    today: {
                        count:
                            Number(
                                today?.count ||
                                    0
                            ),
                        total:
                            Number(
                                today?.total ||
                                    0
                            )
                    },

                    month: {
                        count:
                            Number(
                                month?.count ||
                                    0
                            ),
                        total:
                            Number(
                                month?.total ||
                                    0
                            )
                    },

                    all: {
                        count:
                            Number(
                                all?.count ||
                                    0
                            ),
                        total:
                            Number(
                                all?.total ||
                                    0
                            )
                    }
                },

                recent:
                    recentDonations,

                topDonors,
                goal,
                alertSettings
            });
        } catch (error) {
            console.error(
                "Dashboard error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    `โหลด Dashboard ไม่สำเร็จ: ${error.message}`
            });
        }
    }
);

app.use(
    (error, req, res, next) => {
        if (
            error instanceof
                multer.MulterError &&
            error.code ===
                "LIMIT_FILE_SIZE"
        ) {
            const customSound =
                req.path.includes(
                    "custom-sound"
                );

            return res
                .status(400)
                .json({
                    success: false,

                    message:
                        customSound
                            ? "ไฟล์เสียงต้องไม่เกิน 3 MB"
                            : "ไฟล์สลิปต้องไม่เกิน 4 MB"
                });
        }

        if (error) {
            console.error(
                "Upload Error:",
                error
            );

            return res
                .status(400)
                .json({
                    success: false,
                    message:
                        error.message ||
                        "อัปโหลดไฟล์ไม่สำเร็จ"
                });
        }

        next();
    }
);

let cleanupInterval = null;
let isShuttingDown = false;

async function closeDatabase() {
    try {
        await pool.end();
    } catch (error) {
        console.error(
            "PostgreSQL close error:",
            error
        );
    }
}


/* =========================================================
   YOUTUBE BOT — SAME SERVER
========================================================= */

function installYouTubeBot(
    app,
    options = {}
) {
    const session =
        require("express-session");

    const crypto =
        require("crypto");

    const fs =
        require("fs");

    const path =
        require("path");

    const { google } =
        require("googleapis");

    const missingBotEnv = [
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "GOOGLE_REDIRECT_URI",
        "SESSION_SECRET"
    ].filter(
        key =>
            !String(
                process.env[key] || ""
            ).trim()
    );

    if (missingBotEnv.length) {
        throw new Error(
            `BOT environment variables ไม่ครบ: ${missingBotEnv.join(
                ", "
            )}`
        );
    }

    const DATA_DIR =
        path.resolve(
            __dirname,
            String(
                process.env
                    .BOT_DATA_DIR ||
                    "data"
            )
        );

    const PUBLIC_DIR =
        options.publicDir ||
        path.join(
            __dirname,
            "public"
        );

    const TOKEN_PATH =
        path.resolve(
            __dirname,
            String(
                process.env
                    .BOT_TOKEN_PATH ||
                    "tokens.json"
            )
        );

    fs.mkdirSync(
        DATA_DIR,
        {
            recursive: true
        }
    );

    fs.mkdirSync(
        PUBLIC_DIR,
        {
            recursive: true
        }
    );

    const FILES = {
        settings:
            path.join(
                DATA_DIR,
                "settings.json"
            ),

        commands:
            path.join(
                DATA_DIR,
                "commands.json"
            ),

        automessages:
            path.join(
                DATA_DIR,
                "automessages.json"
            ),

        counters:
            path.join(
                DATA_DIR,
                "counters.json"
            ),

        quotes:
            path.join(
                DATA_DIR,
                "quotes.json"
            ),

        users:
            path.join(
                DATA_DIR,
                "users.json"
            ),

        giveaway:
            path.join(
                DATA_DIR,
                "giveaway.json"
            )
    };

    const DEFAULTS = {
        settings: {
            botName: "AMR29BOT",

            targetLiveVideoId: "",

            caseSensitive: false,

            ignoreBotMessages: true,

            logChatMessages: true,

            autoStart: false,

            welcomeEnabled: false,

            welcomeMessage:
                "👋 ยินดีต้อนรับ {user} เข้าสู่ไลฟ์ AMR29!",

            pointsEnabled: true,

            pointsPerMessage: 2,

            pointsCooldownSeconds: 60,

            activeWindowMinutes: 5,

            maxResponseLength: 200
        },

        commands: [
            {
                id:
                    crypto.randomUUID(),

                name: "Test",

                trigger: "!test",

                aliases: [],

                response:
                    "🤖 AMR29 BOT ทำงานแล้ว!",

                enabled: true,

                minRole: "everyone",

                cooldownSeconds: 3,

                userCooldownSeconds: 8
            }
        ],

        automessages: [],

        counters: {
            wins: 0,
            losses: 0
        },

        quotes: [],

        users: {},

        giveaway: {
            active: false,
            title: "",
            keyword: "!join",
            winnerCount: 1,
            entrants: [],
            startedAt: null,
            lastWinners: []
        }
    };

    function clone(value) {
        return JSON.parse(
            JSON.stringify(value)
        );
    }

    function readJSON(
        filePath,
        fallback
    ) {
        try {
            if (
                !fs.existsSync(
                    filePath
                )
            ) {
                return clone(
                    fallback
                );
            }

            return JSON.parse(
                fs.readFileSync(
                    filePath,
                    "utf8"
                )
            );
        } catch (error) {
            console.error(
                `❌ Read ${path.basename(
                    filePath
                )} failed:`,
                error.message
            );

            return clone(
                fallback
            );
        }
    }

    function writeJSON(
        filePath,
        value
    ) {
        fs.writeFileSync(
            filePath,
            JSON.stringify(
                value,
                null,
                2
            ),
            "utf8"
        );
    }

    for (
        const [key, filePath]
        of Object.entries(FILES)
    ) {
        if (
            !fs.existsSync(
                filePath
            )
        ) {
            writeJSON(
                filePath,
                DEFAULTS[key]
            );
        }
    }

    const loadSettings = () => ({
        ...DEFAULTS.settings,

        ...readJSON(
            FILES.settings,
            DEFAULTS.settings
        )
    });

    const saveSettings =
        value =>
            writeJSON(
                FILES.settings,
                value
            );

    const loadCommands = () => {
        const value =
            readJSON(
                FILES.commands,
                DEFAULTS.commands
            );

        return Array.isArray(value)
            ? value
            : clone(
                  DEFAULTS.commands
              );
    };

    const saveCommands =
        value =>
            writeJSON(
                FILES.commands,
                value
            );

    const loadAutoMessages =
        () => {
            const value =
                readJSON(
                    FILES.automessages,
                    []
                );

            return Array.isArray(value)
                ? value
                : [];
        };

    const saveAutoMessages =
        value =>
            writeJSON(
                FILES.automessages,
                value
            );

    const loadCounters = () => ({
        ...DEFAULTS.counters,

        ...readJSON(
            FILES.counters,
            DEFAULTS.counters
        )
    });

    const saveCounters =
        value =>
            writeJSON(
                FILES.counters,
                value
            );

    const loadQuotes = () => {
        const value =
            readJSON(
                FILES.quotes,
                []
            );

        return Array.isArray(value)
            ? value
            : [];
    };

    const saveQuotes =
        value =>
            writeJSON(
                FILES.quotes,
                value
            );

    const loadUsers = () => {
        const value =
            readJSON(
                FILES.users,
                {}
            );

        return (
            value &&
            typeof value ===
                "object" &&
            !Array.isArray(value)
        )
            ? value
            : {};
    };

    const saveUsers =
        value =>
            writeJSON(
                FILES.users,
                value
            );

    const loadGiveaway =
        () => ({
            ...DEFAULTS.giveaway,

            ...readJSON(
                FILES.giveaway,
                DEFAULTS.giveaway
            )
        });

    const saveGiveaway =
        value =>
            writeJSON(
                FILES.giveaway,
                value
            );

    app.use(
        session({
            secret:
                process.env
                    .SESSION_SECRET,

            resave: false,

            saveUninitialized:
                false,

            cookie: {
                httpOnly: true,

                sameSite: "lax",

                secure:
                    IS_DEPLOYED,

                maxAge:
                    60 *
                    60 *
                    1000
            }
        })
    );

    const oauth2Client =
        new google.auth.OAuth2(
            process.env
                .GOOGLE_CLIENT_ID,

            process.env
                .GOOGLE_CLIENT_SECRET,

            process.env
                .GOOGLE_REDIRECT_URI
        );

    const SCOPES = [
        "https://www.googleapis.com/auth/youtube.force-ssl"
    ];

    function saveTokens(tokens) {
        fs.writeFileSync(
            TOKEN_PATH,
            JSON.stringify(
                tokens,
                null,
                2
            ),
            "utf8"
        );

        console.log(
            "✅ Google token saved"
        );
    }

    function loadTokens() {

    try {

        /* =====================================================
           1. LOCAL / RUNTIME FILE
        ===================================================== */

        if (
            fs.existsSync(
                TOKEN_PATH
            )
        ) {

            return JSON.parse(

                fs.readFileSync(
                    TOKEN_PATH,
                    "utf8"
                )
            );
        }


        /* =====================================================
           2. RENDER ENV FALLBACK

           Environment:
           YOUTUBE_TOKENS_JSON
        ===================================================== */

        const envTokens =

            String(

                process.env
                    .YOUTUBE_TOKENS_JSON ||

                ""
            )
                .trim();


        if (
            envTokens
        ) {

            const parsed =

                JSON.parse(
                    envTokens
                );


            console.log(
                "✅ Google OAuth token loaded from Environment"
            );


            return parsed;
        }


        return null;


    } catch (error) {

        console.error(

            "❌ Cannot load Google OAuth tokens:",

            error.message
        );


        return null;
    }
}

    function youtubeClient() {
        const tokens =
            loadTokens();

        if (!tokens) {
            return null;
        }

        oauth2Client
            .setCredentials(
                tokens
            );

        return google.youtube({
            version: "v3",
            auth: oauth2Client
        });
    }

    function sleep(ms) {
        return new Promise(
            resolve =>
                setTimeout(
                    resolve,
                    ms
                )
        );
    }

    function clamp(
        value,
        min,
        max,
        fallback
    ) {
        const number =
            Number(value);

        if (
            !Number.isFinite(
                number
            )
        ) {
            return fallback;
        }

        return Math.min(
            max,
            Math.max(
                min,
                number
            )
        );
    }

    function apiError(error) {
        const data =
            error?.response?.data ||
            {};

        return {
            status:
                error?.response
                    ?.status ||
                error?.code ||
                null,

            reason:
                data?.error
                    ?.errors?.[0]
                    ?.reason ||
                data?.error
                    ?.status ||
                "unknown",

            message:
                data?.error
                    ?.message ||
                error?.message ||
                "Unknown error"
        };
    }

    function isQuotaError(error) {
        const api =
            apiError(error);

        const text =
            `${api.reason || ""} ${
                api.message || ""
            }`.toLowerCase();

        return (
            text.includes("quota") ||
            text.includes(
                "quotaexceeded"
            ) ||
            text.includes(
                "dailylimitexceeded"
            ) ||
            (
                Number(api.status) ===
                    403 &&
                text.includes(
                    "exceeded"
                )
            )
        );
    }

    function youtubeQuotaError(
        originalError = null
    ) {
        const error =
            new Error(
                "YouTube API Quota หมด กรุณารอ quota reset แล้วลอง Start BOT ใหม่"
            );

        error.code =
            "YOUTUBE_QUOTA_EXCEEDED";

        error.statusCode = 429;

        error.originalError =
            originalError;

        return error;
    }

    function throwIfQuotaError(
        error
    ) {
        if (
            isQuotaError(error)
        ) {
            pushLog(
                "error",
                "YouTube API Quota หมด — หยุดค้นหา Live ทันทีเพื่อไม่ยิง API เพิ่ม"
            );

            throw youtubeQuotaError(
                error
            );
        }
    }

    function isYoutubeQuotaException(
        error
    ) {
        return (
            error?.code ===
                "YOUTUBE_QUOTA_EXCEEDED" ||
            isQuotaError(error)
        );
    }

    function extractVideoId(value) {
        const raw =
            String(
                value || ""
            ).trim();

        if (!raw) {
            return "";
        }

        try {
            if (
                /^https?:\/\//i.test(
                    raw
                )
            ) {
                const url =
                    new URL(raw);

                if (
                    url.hostname.includes(
                        "youtu.be"
                    )
                ) {
                    return (
                        url.pathname
                            .split("/")
                            .filter(
                                Boolean
                            )[0] || ""
                    );
                }

                const queryId =
                    url.searchParams.get(
                        "v"
                    );

                if (queryId) {
                    return queryId.trim();
                }

                const parts =
                    url.pathname
                        .split("/")
                        .filter(Boolean);

                const index =
                    parts.findIndex(
                        part =>
                            [
                                "live",
                                "shorts",
                                "embed"
                            ].includes(
                                part
                            )
                    );

                if (
                    index >= 0 &&
                    parts[index + 1]
                ) {
                    return parts[
                        index + 1
                    ].trim();
                }
            }
        } catch (_) {}

        return raw;
    }

    function targetVideoId() {
        const settings =
            loadSettings();

        return extractVideoId(
            settings
                .targetLiveVideoId ||
                process.env
                    .MAIN_LIVE_VIDEO_ID ||
                ""
        );
    }

    function normalize(
        value,
        sensitive = false
    ) {
        const text =
            String(
                value || ""
            ).trim();

        return sensitive
            ? text
            : text.toLowerCase();
    }

    function roleOf(
        author = {}
    ) {
        if (
            author.isChatOwner
        ) {
            return "owner";
        }

        if (
            author.isChatModerator
        ) {
            return "moderator";
        }

        if (
            author.isChatSponsor
        ) {
            return "member";
        }

        return "everyone";
    }

    function roleAllowed(
        actual,
        required
    ) {
        const rank = {
            everyone: 1,
            member: 2,
            moderator: 3,
            owner: 4
        };

        return (
            rank[actual] || 1
        ) >= (
            rank[required] || 1
        );
    }

    function formatDuration(
        totalMinutes
    ) {
        const minutes =
            Math.max(
                0,
                Math.floor(
                    Number(
                        totalMinutes
                    ) || 0
                )
            );

        const hours =
            Math.floor(
                minutes / 60
            );

        const remaining =
            minutes % 60;

        return hours
            ? `${hours}ชม. ${remaining}น.`
            : `${remaining}น.`;
    }

    function renderTemplate(
        text,
        context = {}
    ) {
        return String(
            text || ""
        )
            .replaceAll(
                "{user}",
                context.user ||
                    "Viewer"
            )
            .replaceAll(
                "{displayName}",
                context.user ||
                    "Viewer"
            )
            .replaceAll(
                "{args}",
                context.args || ""
            )
            .replaceAll(
                "{command}",
                context.command || ""
            )
            .replaceAll(
                "{liveTitle}",
                context.liveTitle ||
                    ""
            )
            .replaceAll(
                "{points}",
                String(
                    context.points ??
                        0
                )
            )
            .replaceAll(
                "{watchtime}",
                context.watchtime ||
                    "0น."
            );
    }

    function pickResponse(text) {
        const responses =
            String(
                text || ""
            )
                .split("||")
                .map(
                    value =>
                        value.trim()
                )
                .filter(Boolean);

        if (
            !responses.length
        ) {
            return "";
        }

        return responses[
            Math.floor(
                Math.random() *
                    responses.length
            )
        ];
    }

    const runtimeLogs = [];

    function pushLog(
        level,
        message,
        meta = null
    ) {
        const item = {
            id:
                crypto.randomUUID(),

            time:
                new Date()
                    .toISOString(),

            level,

            message:
                String(message),

            meta
        };

        runtimeLogs.push(item);

        while (
            runtimeLogs.length >
            300
        ) {
            runtimeLogs.shift();
        }

        const icon = {
            success: "✅",
            error: "❌",
            warn: "⚠️",
            chat: "💬",
            bot: "🤖",
            info: "ℹ️"
        }[level] || "•";

        console.log(
            `${icon} ${message}`
        );
    }

    const globalCooldowns =
        new Map();

    const userCooldowns =
        new Map();

    const welcomedUsers =
        new Set();

    const autoLastSent =
        new Map();

    let botRunning = false;
    let botStopRequested = false;
    let currentLive = null;
    let botIdentity = null;

    const PUBLIC_LIVE_SEARCH_COOLDOWN_MS =
        60 * 1000;

    const OWNED_LIVE_SEARCH_COOLDOWN_MS =
        30 * 1000;

    let resolvedMainChannelHandleCache =
        "";

    let resolvedMainChannelIdCache =
        "";

    let lastPublicSearchAt = 0;

    let lastPublicSearchChannelId =
        "";

    let lastPublicSearchResult =
        null;

    let lastOwnedSearchAt = 0;

    let lastOwnedSearchResult =
        null;

    let recentLiveMessages = [];

    let livePreviewPollingInterval =
        5000;

    function mapLivePreviewMessage(
        message
    ) {
        return {
            id:
                message?.id || "",

            text:
                message?.snippet
                    ?.displayMessage ||
                "",

            publishedAt:
                message?.snippet
                    ?.publishedAt ||
                null,

            author: {
                channelId:
                    message
                        ?.authorDetails
                        ?.channelId ||
                    "",

                name:
                    message
                        ?.authorDetails
                        ?.displayName ||
                    "Unknown",

                avatar:
                    message
                        ?.authorDetails
                        ?.profileImageUrl ||
                    "",

                owner:
                    Boolean(
                        message
                            ?.authorDetails
                            ?.isChatOwner
                    ),

                moderator:
                    Boolean(
                        message
                            ?.authorDetails
                            ?.isChatModerator
                    ),

                member:
                    Boolean(
                        message
                            ?.authorDetails
                            ?.isChatSponsor
                    )
            }
        };
    }

    function cacheLivePreviewMessages(
        items = [],
        pollingIntervalMillis = null
    ) {
        if (
            Number.isFinite(
                Number(
                    pollingIntervalMillis
                )
            )
        ) {
            livePreviewPollingInterval =
                Math.max(
                    Number(
                        pollingIntervalMillis
                    ),
                    1000
                );
        }

        if (
            !Array.isArray(
                items
            ) ||
            !items.length
        ) {
            return;
        }

        const map =
            new Map(
                recentLiveMessages.map(
                    item => [
                        item.id,
                        item
                    ]
                )
            );

        for (
            const message
            of items
        ) {
            const mapped =
                mapLivePreviewMessage(
                    message
                );

            if (mapped.id) {
                map.set(
                    mapped.id,
                    mapped
                );
            }
        }

        recentLiveMessages =
            Array.from(
                map.values()
            )
                .sort(
                    (a, b) =>
                        new Date(
                            a.publishedAt ||
                                0
                        ).getTime() -
                        new Date(
                            b.publishedAt ||
                                0
                        ).getTime()
                )
                .slice(-100);
    }

    function clearLivePreviewCache() {
        recentLiveMessages = [];
        livePreviewPollingInterval =
            5000;
    }

    async function getBotIdentity(
        youtube,
        force = false
    ) {
        if (
            botIdentity &&
            !force
        ) {
            return botIdentity;
        }

        const response =
            await youtube.channels.list(
                {
                    part: [
                        "snippet"
                    ],

                    mine: true
                }
            );

        const channel =
            response.data
                .items?.[0];

        if (!channel) {
            return null;
        }

        botIdentity = {
            id: channel.id,

            name:
                channel.snippet
                    ?.title ||
                "Unknown",

            avatar:
                channel.snippet
                    ?.thumbnails
                    ?.high?.url ||
                channel.snippet
                    ?.thumbnails
                    ?.default?.url ||
                ""
        };

        return botIdentity;
    }

    function makeLiveInfo(video) {
        if (!video) {
            return null;
        }

        const liveChatId =
            video
                .liveStreamingDetails
                ?.activeLiveChatId;

        if (!liveChatId) {
            return null;
        }

        return {
            videoId: video.id,

            liveChatId,

            title:
                video.snippet
                    ?.title ||
                "Untitled Live",

            channelId:
                video.snippet
                    ?.channelId ||
                "",

            actualStartTime:
                video
                    .liveStreamingDetails
                    ?.actualStartTime ||
                video
                    .liveStreamingDetails
                    ?.scheduledStartTime ||
                null
        };
    }

    async function getVideoDetails(
        youtube,
        videoId
    ) {
        const id =
            extractVideoId(
                videoId
            );

        if (!id) {
            return null;
        }

        const response =
            await youtube.videos.list(
                {
                    part: [
                        "snippet",
                        "liveStreamingDetails"
                    ],

                    id: [id],

                    maxResults: 1
                }
            );

        return (
            response.data
                .items?.[0] ||
            null
        );
    }

    async function getChannelIdFromHandle(
        youtube,
        handle
    ) {
        const cleanHandle =
            String(
                handle || ""
            ).trim();

        if (!cleanHandle) {
            return null;
        }

        if (
            resolvedMainChannelHandleCache ===
                cleanHandle &&
            resolvedMainChannelIdCache
        ) {
            return resolvedMainChannelIdCache;
        }

        try {
            const response =
                await youtube.channels.list(
                    {
                        part: [
                            "id",
                            "snippet"
                        ],

                        forHandle:
                            cleanHandle
                    }
                );

            const channel =
                response.data
                    .items?.[0];

            if (!channel) {
                pushLog(
                    "warn",
                    `หา Channel จาก Handle ไม่เจอ: ${cleanHandle}`
                );

                return null;
            }

            resolvedMainChannelHandleCache =
                cleanHandle;

            resolvedMainChannelIdCache =
                channel.id;

            pushLog(
                "success",
                `Channel resolved: ${
                    channel.snippet
                        ?.title ||
                    cleanHandle
                } | ${channel.id}`
            );

            return channel.id;
        } catch (error) {
            throwIfQuotaError(
                error
            );

            throw error;
        }
    }

    async function findPublicLiveByChannel(
        youtube,
        channelId,
        force = false
    ) {
        const id =
            String(
                channelId || ""
            ).trim();

        if (!id) {
            return null;
        }

        const now =
            Date.now();

        if (
            !force &&
            lastPublicSearchChannelId ===
                id &&
            now -
                lastPublicSearchAt <
                PUBLIC_LIVE_SEARCH_COOLDOWN_MS
        ) {
            return lastPublicSearchResult;
        }

        lastPublicSearchAt = now;

        lastPublicSearchChannelId =
            id;

        pushLog(
            "info",
            `กำลังค้นหา Public Live อัตโนมัติของ Channel: ${id}`
        );

        try {
            const searchResponse =
                await youtube.search.list(
                    {
                        part: [
                            "snippet"
                        ],

                        channelId: id,

                        eventType:
                            "live",

                        type: [
                            "video"
                        ],

                        order: "date",

                        maxResults: 10
                    }
                );

            const videoIds =
                (
                    searchResponse
                        .data.items ||
                    []
                )
                    .map(
                        item =>
                            item.id
                                ?.videoId
                    )
                    .filter(Boolean);

            if (
                !videoIds.length
            ) {
                lastPublicSearchResult =
                    null;

                pushLog(
                    "warn",
                    "ยังไม่พบ Public Live ที่กำลัง LIVE ของช่อง AMR29"
                );

                return null;
            }

            const videosResponse =
                await youtube.videos.list(
                    {
                        part: [
                            "snippet",
                            "liveStreamingDetails"
                        ],

                        id: videoIds
                    }
                );

            const activeVideos =
                (
                    videosResponse
                        .data.items ||
                    []
                )
                    .filter(
                        video =>
                            Boolean(
                                video
                                    .liveStreamingDetails
                                    ?.activeLiveChatId
                            )
                    )
                    .sort(
                        (a, b) => {
                            const aTime =
                                new Date(
                                    a
                                        .liveStreamingDetails
                                        ?.actualStartTime ||
                                    a
                                        .liveStreamingDetails
                                        ?.scheduledStartTime ||
                                    0
                                ).getTime();

                            const bTime =
                                new Date(
                                    b
                                        .liveStreamingDetails
                                        ?.actualStartTime ||
                                    b
                                        .liveStreamingDetails
                                        ?.scheduledStartTime ||
                                    0
                                ).getTime();

                            return (
                                bTime -
                                aTime
                            );
                        }
                    );

            const live =
                makeLiveInfo(
                    activeVideos[0]
                );

            lastPublicSearchResult =
                live || null;

            if (live) {
                pushLog(
                    "success",
                    `Auto Live found: ${live.title} | ${live.videoId}`
                );
            }

            return live;
        } catch (error) {
            lastPublicSearchResult =
                null;

            throwIfQuotaError(
                error
            );

            const api =
                apiError(error);

            pushLog(
                "warn",
                `ค้นหา Public Live ไม่สำเร็จ: ${api.message}`
            );

            return null;
        }
    }

    async function findOwnedLiveBroadcast(
        youtube,
        force = false
    ) {
        const now =
            Date.now();

        if (
            !force &&
            now -
                lastOwnedSearchAt <
                OWNED_LIVE_SEARCH_COOLDOWN_MS
        ) {
            return lastOwnedSearchResult;
        }

        lastOwnedSearchAt =
            now;

        for (
            const broadcastStatus
            of [
                "active",
                "upcoming"
            ]
        ) {
            try {
                const response =
                    await youtube
                        .liveBroadcasts
                        .list({
                            part: [
                                "id",
                                "snippet",
                                "status"
                            ],

                            mine: true,

                            broadcastStatus,

                            broadcastType:
                                "all",

                            maxResults:
                                50
                        });

                const broadcasts =
                    response.data
                        .items ||
                    [];

                const withChat =
                    broadcasts
                        .filter(
                            item =>
                                Boolean(
                                    item
                                        .snippet
                                        ?.liveChatId
                                )
                        )
                        .sort(
                            (a, b) => {
                                const aTime =
                                    new Date(
                                        a
                                            .snippet
                                            ?.actualStartTime ||
                                        a
                                            .snippet
                                            ?.scheduledStartTime ||
                                        0
                                    ).getTime();

                                const bTime =
                                    new Date(
                                        b
                                            .snippet
                                            ?.actualStartTime ||
                                        b
                                            .snippet
                                            ?.scheduledStartTime ||
                                        0
                                    ).getTime();

                                return (
                                    bTime -
                                    aTime
                                );
                            }
                        );

                const broadcast =
                    withChat[0];

                if (broadcast) {
                    const live = {
                        videoId:
                            broadcast.id,

                        liveChatId:
                            broadcast
                                .snippet
                                .liveChatId,

                        title:
                            broadcast
                                .snippet
                                ?.title ||
                            "Untitled Live",

                        channelId:
                            botIdentity
                                ?.id ||
                            "",

                        actualStartTime:
                            broadcast
                                .snippet
                                ?.actualStartTime ||
                            broadcast
                                .snippet
                                ?.scheduledStartTime ||
                            null
                    };

                    lastOwnedSearchResult =
                        live;

                    pushLog(
                        "success",
                        `OAuth ${broadcastStatus} Live found: ${live.title} | ${live.videoId}`
                    );

                    return live;
                }
            } catch (error) {
                throwIfQuotaError(
                    error
                );

                const api =
                    apiError(error);

                pushLog(
                    "warn",
                    `ค้นหา OAuth ${broadcastStatus} Live ไม่สำเร็จ: ${api.message}`
                );
            }
        }

        lastOwnedSearchResult =
            null;

        return null;
    }

    async function getLive(
        youtube,
        options = {}
    ) {
        const forceDiscovery =
            Boolean(
                options.forceDiscovery
            );

        const configuredVideoId =
            targetVideoId();

        let seedChannelId = "";

        if (configuredVideoId) {
            try {
                pushLog(
                    "info",
                    `กำลังเช็ก Target Live: ${configuredVideoId}`
                );

                const targetVideo =
                    await getVideoDetails(
                        youtube,
                        configuredVideoId
                    );

                if (targetVideo) {
                    seedChannelId =
                        targetVideo
                            .snippet
                            ?.channelId ||
                        "";

                    const directLive =
                        makeLiveInfo(
                            targetVideo
                        );

                    if (
                        directLive
                    ) {
                        pushLog(
                            "success",
                            `Target Live connected: ${directLive.title} | ${directLive.videoId}`
                        );

                        return directLive;
                    }

                    pushLog(
                        "warn",
                        `พบ Target Video ${configuredVideoId} แต่ Live Chat ยังไม่ Active`
                    );
                } else {
                    pushLog(
                        "warn",
                        `ไม่พบ Target Video: ${configuredVideoId}`
                    );
                }
            } catch (error) {
                throwIfQuotaError(
                    error
                );

                const api =
                    apiError(error);

                pushLog(
                    "warn",
                    `ตรวจ Target Live ไม่สำเร็จ: ${api.message}`
                );
            }
        }

        try {
            const ownedLive =
                await findOwnedLiveBroadcast(
                    youtube,
                    forceDiscovery
                );

            if (ownedLive) {
                return ownedLive;
            }
        } catch (error) {
            if (
                isYoutubeQuotaException(
                    error
                )
            ) {
                throw youtubeQuotaError(
                    error
                );
            }

            throw error;
        }

        let channelId =
            String(
                process.env
                    .MAIN_CHANNEL_ID ||
                    ""
            ).trim() ||
            seedChannelId;

        const channelHandle =
            String(
                process.env
                    .MAIN_CHANNEL_HANDLE ||
                    ""
            ).trim();

        if (channelHandle) {
            try {
                const resolvedChannelId =
                    await getChannelIdFromHandle(
                        youtube,
                        channelHandle
                    );

                if (
                    resolvedChannelId
                ) {
                    channelId =
                        resolvedChannelId;
                }
            } catch (error) {
                if (
                    isYoutubeQuotaException(
                        error
                    )
                ) {
                    throw youtubeQuotaError(
                        error
                    );
                }

                pushLog(
                    "warn",
                    `Resolve Channel Handle ไม่สำเร็จ: ${apiError(error).message}`
                );
            }
        }

        if (channelId) {
            const autoLive =
                await findPublicLiveByChannel(
                    youtube,
                    channelId,
                    forceDiscovery
                );

            if (autoLive) {
                return autoLive;
            }
        }

        try {
            const identity =
                await getBotIdentity(
                    youtube
                );

            const oauthChannelId =
                identity?.id || "";

            if (
                oauthChannelId &&
                oauthChannelId !==
                    channelId
            ) {
                const oauthPublicLive =
                    await findPublicLiveByChannel(
                        youtube,
                        oauthChannelId,
                        forceDiscovery
                    );

                if (
                    oauthPublicLive
                ) {
                    return oauthPublicLive;
                }
            }
        } catch (error) {
            if (
                isYoutubeQuotaException(
                    error
                )
            ) {
                throw youtubeQuotaError(
                    error
                );
            }

            pushLog(
                "warn",
                `Public OAuth fallback ไม่สำเร็จ: ${apiError(error).message}`
            );
        }

        if (configuredVideoId) {
            pushLog(
                "error",
                "หาไลฟ์ไม่เจอ: ถ้าเป็น Unlisted ให้ตรวจ Target URL / Video ID และเปิด Live Chat"
            );
        } else {
            pushLog(
                "warn",
                "ไม่พบ Live ที่เชื่อมต่อได้"
            );
        }

        return null;
    }

    async function sendChat(
        youtube,
        liveChatId,
        text
    ) {
        const maxLength =
            clamp(
                loadSettings()
                    .maxResponseLength,
                1,
                200,
                200
            );

        const message =
            String(text || "")
                .trim()
                .slice(
                    0,
                    maxLength
                );

        if (!message) {
            return {
                success: false,
                reason:
                    "emptyMessage",
                message:
                    "ข้อความว่าง"
            };
        }

        try {
            const response =
                await youtube
                    .liveChatMessages
                    .insert({
                        part: [
                            "snippet"
                        ],

                        requestBody: {
                            snippet: {
                                liveChatId,

                                type:
                                    "textMessageEvent",

                                textMessageDetails:
                                    {
                                        messageText:
                                            message
                                    }
                            }
                        }
                    });

            pushLog(
                "bot",
                `BOT SENT: ${message}`
            );

            return {
                success: true,
                id:
                    response.data?.id ||
                    null,
                message
            };
        } catch (error) {
            const api =
                apiError(error);

            pushLog(
                "error",
                `BOT SEND FAILED | ${
                    api.status || "?"
                } | ${api.reason} | ${api.message}`
            );

            return {
                success: false,
                ...api
            };
        }
    }

    function updateUser(message) {
        const settings =
            loadSettings();

        const author =
            message.authorDetails ||
            {};

        const channelId =
            String(
                author.channelId ||
                    ""
            );

        if (!channelId) {
            return null;
        }

        const users =
            loadUsers();

        const now =
            Date.now();

        const user =
            users[channelId] || {
                channelId,
                name:
                    author.displayName ||
                    "Unknown",
                avatar:
                    author.profileImageUrl ||
                    "",
                points: 0,
                activeMinutes: 0,
                messages: 0,
                lastSeenAt: null,
                lastPointAt: null
            };

        user.name =
            author.displayName ||
            user.name;

        user.avatar =
            author.profileImageUrl ||
            user.avatar;

        user.messages =
            Number(
                user.messages || 0
            ) + 1;

        if (user.lastSeenAt) {
            const previous =
                new Date(
                    user.lastSeenAt
                ).getTime();

            const differenceMinutes =
                Math.max(
                    0,
                    (now - previous) /
                        60000
                );

            const activeWindow =
                clamp(
                    settings
                        .activeWindowMinutes,
                    1,
                    30,
                    5
                );

            if (
                differenceMinutes <=
                activeWindow
            ) {
                user.activeMinutes =
                    Number(
                        user.activeMinutes ||
                            0
                    ) +
                    differenceMinutes;
            } else {
                user.activeMinutes =
                    Number(
                        user.activeMinutes ||
                            0
                    ) + 1;
            }
        } else {
            user.activeMinutes =
                Number(
                    user.activeMinutes ||
                        0
                ) + 1;
        }

        if (
            settings.pointsEnabled
        ) {
            const cooldown =
                clamp(
                    settings
                        .pointsCooldownSeconds,
                    0,
                    3600,
                    60
                ) * 1000;

            const lastPointAt =
                user.lastPointAt
                    ? new Date(
                          user.lastPointAt
                      ).getTime()
                    : 0;

            if (
                !lastPointAt ||
                now - lastPointAt >=
                    cooldown
            ) {
                user.points =
                    Number(
                        user.points || 0
                    ) +
                    clamp(
                        settings
                            .pointsPerMessage,
                        0,
                        1000,
                        2
                    );

                user.lastPointAt =
                    new Date(
                        now
                    ).toISOString();
            }
        }

        user.lastSeenAt =
            new Date(
                now
            ).toISOString();

        users[channelId] = user;

        saveUsers(users);

        return user;
    }

    function sanitizeCommand(
        input = {},
        existing = {}
    ) {
        const aliases =
            Array.isArray(
                input.aliases
            )
                ? input.aliases
                : String(
                      input.aliases ??
                          existing.aliases ??
                          ""
                  ).split(",");

        const requestedRole =
            String(
                input.minRole ??
                    existing.minRole ??
                    "everyone"
            );

        const minRole =
            [
                "everyone",
                "member",
                "moderator",
                "owner"
            ].includes(
                requestedRole
            )
                ? requestedRole
                : "everyone";

        return {
            id:
                existing.id ||
                input.id ||
                crypto.randomUUID(),

            name:
                String(
                    input.name ??
                        existing.name ??
                        "Command"
                ).trim(),

            trigger:
                String(
                    input.trigger ??
                        existing.trigger ??
                        ""
                ).trim(),

            aliases:
                aliases
                    .map(
                        value =>
                            String(
                                value || ""
                            ).trim()
                    )
                    .filter(Boolean),

            response:
                String(
                    input.response ??
                        existing.response ??
                        ""
                ).trim(),

            enabled:
                typeof input.enabled ===
                "boolean"
                    ? input.enabled
                    : existing.enabled ??
                      true,

            minRole,

            cooldownSeconds:
                clamp(
                    input.cooldownSeconds ??
                        existing.cooldownSeconds,
                    0,
                    3600,
                    3
                ),

            userCooldownSeconds:
                clamp(
                    input.userCooldownSeconds ??
                        existing.userCooldownSeconds,
                    0,
                    3600,
                    8
                )
        };
    }

    function matchCustom(
        text,
        command,
        settings
    ) {
        const source =
            normalize(
                text,
                settings.caseSensitive
            );

        const rawTriggers =
            [
                command.trigger,

                ...(command.aliases ||
                    [])
            ]
                .map(
                    value =>
                        String(
                            value || ""
                        ).trim()
                )
                .filter(Boolean);

        for (
            const rawTrigger
            of rawTriggers
        ) {
            const trigger =
                normalize(
                    rawTrigger,
                    settings
                        .caseSensitive
                );

            if (
                source === trigger
            ) {
                return {
                    matched: true,
                    usedTrigger:
                        rawTrigger,
                    args: ""
                };
            }

            if (
                source.startsWith(
                    `${trigger} `
                )
            ) {
                return {
                    matched: true,

                    usedTrigger:
                        rawTrigger,

                    args:
                        String(text)
                            .trim()
                            .slice(
                                rawTrigger
                                    .length
                            )
                            .trim()
                };
            }
        }

        return {
            matched: false,
            usedTrigger: null,
            args: ""
        };
    }

    function checkCooldown(
        command,
        userId
    ) {
        const now =
            Date.now();

        const globalMs =
            clamp(
                command
                    .cooldownSeconds,
                0,
                3600,
                0
            ) * 1000;

        const userMs =
            clamp(
                command
                    .userCooldownSeconds,
                0,
                3600,
                0
            ) * 1000;

        const globalLast =
            globalCooldowns.get(
                command.id
            ) || 0;

        const userKey =
            `${command.id}:${
                userId ||
                "unknown"
            }`;

        const userLast =
            userCooldowns.get(
                userKey
            ) || 0;

        if (
            globalMs > 0 &&
            now - globalLast <
                globalMs
        ) {
            return false;
        }

        if (
            userMs > 0 &&
            now - userLast <
                userMs
        ) {
            return false;
        }

        globalCooldowns.set(
            command.id,
            now
        );

        userCooldowns.set(
            userKey,
            now
        );

        return true;
    }

    async function handleCustom(
        youtube,
        liveChatId,
        message,
        text,
        user
    ) {
        const settings =
            loadSettings();

        const author =
            message.authorDetails ||
            {};

        const actualRole =
            roleOf(author);

        for (
            const command
            of loadCommands()
        ) {
            if (!command.enabled) {
                continue;
            }

            const match =
                matchCustom(
                    text,
                    command,
                    settings
                );

            if (!match.matched) {
                continue;
            }

            if (
                !roleAllowed(
                    actualRole,
                    command.minRole ||
                        "everyone"
                )
            ) {
                pushLog(
                    "warn",
                    `${
                        author.displayName ||
                        "Unknown"
                    } ใช้ ${
                        command.trigger
                    } ไม่ได้ เพราะต้องเป็น ${
                        command.minRole
                    }`
                );

                return true;
            }

            if (
                !checkCooldown(
                    command,
                    String(
                        author.channelId ||
                            ""
                    )
                )
            ) {
                return true;
            }

            const selectedResponse =
                pickResponse(
                    command.response
                );

            const rendered =
                renderTemplate(
                    selectedResponse,
                    {
                        user:
                            author.displayName ||
                            "Viewer",

                        args:
                            match.args,

                        command:
                            command.trigger,

                        liveTitle:
                            currentLive
                                ?.title ||
                            "",

                        points:
                            Math.floor(
                                user?.points ||
                                    0
                            ),

                        watchtime:
                            formatDuration(
                                user?.activeMinutes ||
                                    0
                            )
                    }
                );

            if (rendered) {
                pushLog(
                    "info",
                    `Command matched: ${
                        command.trigger
                    } by ${
                        author.displayName ||
                        "Unknown"
                    }`
                );

                await sendChat(
                    youtube,
                    liveChatId,
                    rendered
                );
            }

            return true;
        }

        return false;
    }

    async function maybeWelcome(
        youtube,
        liveChatId,
        message
    ) {
        const settings =
            loadSettings();

        if (
            !settings
                .welcomeEnabled
        ) {
            return;
        }

        const author =
            message.authorDetails ||
            {};

        const channelId =
            String(
                author.channelId ||
                    ""
            );

        if (
            !channelId ||
            welcomedUsers.has(
                channelId
            ) ||
            channelId ===
                botIdentity?.id
        ) {
            return;
        }

        welcomedUsers.add(
            channelId
        );

        const text =
            renderTemplate(
                settings
                    .welcomeMessage,
                {
                    user:
                        author.displayName ||
                        "Viewer",

                    liveTitle:
                        currentLive?.title ||
                        ""
                }
            );

        if (text) {
            await sendChat(
                youtube,
                liveChatId,
                text
            );
        }
    }

    async function handleGiveawayJoin(
        message,
        text
    ) {
        const giveaway =
            loadGiveaway();

        if (
            !giveaway.active ||
            normalize(text) !==
                normalize(
                    giveaway.keyword ||
                        "!join"
                )
        ) {
            return false;
        }

        const author =
            message.authorDetails ||
            {};

        const channelId =
            String(
                author.channelId ||
                    ""
            );

        if (
            !channelId ||
            channelId ===
                botIdentity?.id
        ) {
            return true;
        }

        if (
            !giveaway.entrants.some(
                item =>
                    item.channelId ===
                    channelId
            )
        ) {
            giveaway.entrants.push(
                {
                    channelId,

                    name:
                        author.displayName ||
                        "Unknown",

                    avatar:
                        author.profileImageUrl ||
                        "",

                    joinedAt:
                        new Date()
                            .toISOString()
                }
            );

            saveGiveaway(
                giveaway
            );

            pushLog(
                "info",
                `Giveaway join: ${
                    author.displayName ||
                    channelId
                }`
            );
        }

        return true;
    }

    async function drawGiveaway(
        youtube = null,
        liveChatId = null
    ) {
        const giveaway =
            loadGiveaway();

        if (!giveaway.active) {
            return {
                success: false,
                message:
                    "Giveaway ยังไม่ได้ Start"
            };
        }

        if (
            !giveaway.entrants
                .length
        ) {
            return {
                success: false,
                message:
                    "ยังไม่มีผู้เข้าร่วม"
            };
        }

        const pool = [
            ...giveaway.entrants
        ];

        const winners = [];

        const amount =
            Math.min(
                clamp(
                    giveaway
                        .winnerCount,
                    1,
                    20,
                    1
                ),
                pool.length
            );

        while (
            winners.length <
            amount
        ) {
            const index =
                Math.floor(
                    Math.random() *
                        pool.length
                );

            winners.push(
                pool.splice(
                    index,
                    1
                )[0]
            );
        }

        giveaway.lastWinners =
            winners;

        saveGiveaway(
            giveaway
        );

        if (
            youtube &&
            liveChatId
        ) {
            await sendChat(
                youtube,
                liveChatId,
                `🎉 ผู้ชนะ Giveaway: ${
                    winners
                        .map(
                            item =>
                                item.name
                        )
                        .join(", ")
                }`
            );
        }

        return {
            success: true,
            winners
        };
    }

    async function handleBuiltin(
        youtube,
        liveChatId,
        message,
        text,
        user
    ) {
        const author =
            message.authorDetails ||
            {};

        const actualRole =
            roleOf(author);

        const lower =
            text.toLowerCase();

        const counters =
            loadCounters();

        if (lower === "!uptime") {
            let minutes = 0;

            if (
                currentLive
                    ?.actualStartTime
            ) {
                minutes =
                    (
                        Date.now() -
                        new Date(
                            currentLive
                                .actualStartTime
                        ).getTime()
                    ) /
                    60000;
            }

            await sendChat(
                youtube,
                liveChatId,
                `⏱️ ไลฟ์มาแล้ว ${formatDuration(
                    minutes
                )}`
            );

            return true;
        }

        if (lower === "!score") {
            await sendChat(
                youtube,
                liveChatId,
                `⚽ สถิติวันนี้: ชนะ ${counters.wins} | แพ้ ${counters.losses}`
            );

            return true;
        }

        if (
            lower === "!points"
        ) {
            await sendChat(
                youtube,
                liveChatId,
                `⭐ ${
                    author.displayName ||
                    "Viewer"
                }: ${Math.floor(
                    user?.points || 0
                )} points`
            );

            return true;
        }

        if (
            lower ===
            "!watchtime"
        ) {
            await sendChat(
                youtube,
                liveChatId,
                `🕒 ${
                    author.displayName ||
                    "Viewer"
                }: Active Watchtime ${formatDuration(
                    user?.activeMinutes ||
                        0
                )}`
            );

            return true;
        }

        if (lower === "!top") {
            const top =
                Object.values(
                    loadUsers()
                )
                    .sort(
                        (a, b) =>
                            (b.points ||
                                0) -
                            (a.points ||
                                0)
                    )
                    .slice(0, 5);

            const topText =
                top.length
                    ? top
                          .map(
                              (
                                  item,
                                  index
                              ) =>
                                  `${
                                      index +
                                      1
                                  }.${
                                      item.name
                                  } ${Math.floor(
                                      item.points ||
                                          0
                                  )}`
                          )
                          .join(" | ")
                    : "ยังไม่มีข้อมูล";

            await sendChat(
                youtube,
                liveChatId,
                `🏆 Top Points: ${topText}`
            );

            return true;
        }

        if (
            lower === "!quote"
        ) {
            const quotes =
                loadQuotes();

            if (
                !quotes.length
            ) {
                await sendChat(
                    youtube,
                    liveChatId,
                    "📜 ยังไม่มี Quote"
                );

                return true;
            }

            const quote =
                quotes[
                    Math.floor(
                        Math.random() *
                            quotes.length
                    )
                ];

            await sendChat(
                youtube,
                liveChatId,
                `📜 #${
                    quote.number || "?"
                } ${quote.text}`
            );

            return true;
        }

        if (
            lower === "!win" &&
            roleAllowed(
                actualRole,
                "moderator"
            )
        ) {
            counters.wins++;

            saveCounters(
                counters
            );

            await sendChat(
                youtube,
                liveChatId,
                `✅ WIN +1 | ${counters.wins}-${counters.losses}`
            );

            return true;
        }

        if (
            lower === "!lose" &&
            roleAllowed(
                actualRole,
                "moderator"
            )
        ) {
            counters.losses++;

            saveCounters(
                counters
            );

            await sendChat(
                youtube,
                liveChatId,
                `❌ LOSE +1 | ${counters.wins}-${counters.losses}`
            );

            return true;
        }

        if (
            lower ===
                "!resetwl" &&
            roleAllowed(
                actualRole,
                "moderator"
            )
        ) {
            saveCounters({
                wins: 0,
                losses: 0
            });

            await sendChat(
                youtube,
                liveChatId,
                "♻️ รีเซ็ต Win/Lose แล้ว"
            );

            return true;
        }

        if (
            lower.startsWith(
                "!addquote "
            ) &&
            roleAllowed(
                actualRole,
                "moderator"
            )
        ) {
            const body =
                text
                    .slice(10)
                    .trim();

            if (body) {
                const quotes =
                    loadQuotes();

                const nextNumber =
                    quotes.length
                        ? Math.max(
                              ...quotes.map(
                                  item =>
                                      Number(
                                          item.number
                                      ) || 0
                              )
                          ) + 1
                        : 1;

                quotes.push({
                    id:
                        crypto.randomUUID(),

                    number:
                        nextNumber,

                    text: body,

                    addedBy:
                        author.displayName ||
                        "Unknown",

                    createdAt:
                        new Date()
                            .toISOString()
                });

                saveQuotes(
                    quotes
                );

                await sendChat(
                    youtube,
                    liveChatId,
                    `📜 เพิ่ม Quote #${nextNumber} แล้ว`
                );
            }

            return true;
        }

        if (
            lower === "!draw" &&
            roleAllowed(
                actualRole,
                "moderator"
            )
        ) {
            const result =
                await drawGiveaway(
                    youtube,
                    liveChatId
                );

            if (
                !result.success
            ) {
                await sendChat(
                    youtube,
                    liveChatId,
                    `🎁 ${result.message}`
                );
            }

            return true;
        }

        return false;
    }

    async function processMessage(
        youtube,
        liveChatId,
        message
    ) {
        const settings =
            loadSettings();

        if (
            message?.snippet
                ?.type !==
            "textMessageEvent"
        ) {
            return;
        }

        const text =
            String(
                message.snippet
                    .displayMessage ||
                    ""
            ).trim();

        const author =
            message.authorDetails ||
            {};

        if (!text) {
            return;
        }

        if (
            settings
                .ignoreBotMessages &&
            botIdentity?.id &&
            author.channelId ===
                botIdentity.id
        ) {
            return;
        }

        if (
            settings
                .logChatMessages
        ) {
            pushLog(
                "chat",
                `${
                    author.displayName ||
                    "Unknown"
                }: ${text}`
            );
        }

        const user =
            updateUser(message);

        await maybeWelcome(
            youtube,
            liveChatId,
            message
        );

        if (
            await handleGiveawayJoin(
                message,
                text
            )
        ) {
            return;
        }

        if (
            await handleCustom(
                youtube,
                liveChatId,
                message,
                text,
                user
            )
        ) {
            return;
        }

        await handleBuiltin(
            youtube,
            liveChatId,
            message,
            text,
            user
        );
    }

    async function processAutoMessages(
        youtube,
        liveChatId
    ) {
        const now =
            Date.now();

        for (
            const item
            of loadAutoMessages()
        ) {
            if (
                !item.enabled ||
                !String(
                    item.text || ""
                ).trim()
            ) {
                continue;
            }

            const interval =
                clamp(
                    item
                        .intervalMinutes,
                    1,
                    1440,
                    10
                ) *
                60000;

            if (
                !autoLastSent.has(
                    item.id
                )
            ) {
                autoLastSent.set(
                    item.id,
                    now
                );

                continue;
            }

            const last =
                autoLastSent.get(
                    item.id
                ) || now;

            if (
                now - last >=
                interval
            ) {
                await sendChat(
                    youtube,
                    liveChatId,
                    renderTemplate(
                        item.text,
                        {
                            liveTitle:
                                currentLive
                                    ?.title ||
                                ""
                        }
                    )
                );

                autoLastSent.set(
                    item.id,
                    now
                );
            }
        }
    }

    async function startBotLoop() {
        if (botRunning) {
            return;
        }

        botRunning = true;
        botStopRequested = false;

        welcomedUsers.clear();
        autoLastSent.clear();
        clearLivePreviewCache();

        pushLog(
            "info",
            "กำลัง Start AMR29BOT..."
        );

        try {
            const youtube =
                youtubeClient();

            if (!youtube) {
                throw new Error(
                    "ยังไม่ได้เชื่อม Google OAuth"
                );
            }

            const identity =
                await getBotIdentity(
                    youtube,
                    true
                );

            if (!identity) {
                throw new Error(
                    "ไม่พบ Channel ของ BOT"
                );
            }

            pushLog(
                "success",
                `OAuth Identity: ${identity.name}`
            );

            currentLive =
                currentLive ||
                await getLive(
                    youtube
                );

            if (!currentLive) {
                throw new Error(
                    "ไม่พบ Active Live Chat ของ AMR29"
                );
            }

            pushLog(
                "success",
                `Live connected: ${currentLive.title}`
            );

            let response =
                await youtube
                    .liveChatMessages
                    .list({
                        liveChatId:
                            currentLive
                                .liveChatId,

                        part: [
                            "id",
                            "snippet",
                            "authorDetails"
                        ],

                        maxResults:
                            200,

                        profileImageSize:
                            32
                    });

            cacheLivePreviewMessages(
                response.data
                    .items || [],
                response.data
                    .pollingIntervalMillis
            );

            let nextPageToken =
                response.data
                    .nextPageToken;

            let polling =
                Math.max(
                    Number(
                        response.data
                            .pollingIntervalMillis
                    ) || 5000,
                    1000
                );

            pushLog(
                "success",
                "Live Chat Listener Ready"
            );

            while (
                !botStopRequested
            ) {
                await sleep(polling);

                const result =
                    await youtube
                        .liveChatMessages
                        .list({
                            liveChatId:
                                currentLive
                                    .liveChatId,

                            part: [
                                "id",
                                "snippet",
                                "authorDetails"
                            ],

                            pageToken:
                                nextPageToken,

                            maxResults:
                                200,

                            profileImageSize:
                                32
                        });

                if (
                    result.data
                        .nextPageToken
                ) {
                    nextPageToken =
                        result.data
                            .nextPageToken;
                }

                polling =
                    Math.max(
                        Number(
                            result.data
                                .pollingIntervalMillis
                        ) || 5000,
                        1000
                    );

                cacheLivePreviewMessages(
                    result.data
                        .items || [],
                    result.data
                        .pollingIntervalMillis
                );

                for (
                    const message
                    of result.data
                        .items || []
                ) {
                    await processMessage(
                        youtube,
                        currentLive
                            .liveChatId,
                        message
                    );
                }

                await processAutoMessages(
                    youtube,
                    currentLive
                        .liveChatId
                );

                if (
                    result.data
                        .offlineAt
                ) {
                    pushLog(
                        "warn",
                        "Live ended"
                    );

                    break;
                }
            }
        } catch (error) {
            if (
                isYoutubeQuotaException(
                    error
                )
            ) {
                pushLog(
                    "error",
                    "BOT ERROR | YouTube API Quota หมด"
                );
            } else {
                const api =
                    apiError(error);

                pushLog(
                    "error",
                    `BOT ERROR | ${
                        api.status ||
                        "?"
                    } | ${
                        api.reason
                    } | ${
                        api.message
                    }`
                );
            }
        } finally {
            botRunning = false;
            botStopRequested =
                false;
            currentLive = null;

            clearLivePreviewCache();

            pushLog(
                "warn",
                "AMR29BOT STOPPED"
            );
        }
    }

    app.get(
        "/dashboard",
        (req, res) => {
            res.redirect(
                "/dashboard.html#bot"
            );
        }
    );

    app.get(
        "/preview",
        (req, res) => {
            const previewPath =
                path.join(
                    PUBLIC_DIR,
                    "preview.html"
                );

            if (
                !fs.existsSync(
                    previewPath
                )
            ) {
                return res
                    .status(404)
                    .send(
                        "BOT preview.html not found"
                    );
            }

            res.sendFile(
                previewPath
            );
        }
    );

    app.get(
        "/auth/google",
        (req, res) => {
            const state =
                crypto
                    .randomBytes(32)
                    .toString("hex");

            req.session.oauthState =
                state;

            const url =
                oauth2Client
                    .generateAuthUrl({
                        access_type:
                            "offline",

                        scope:
                            SCOPES,

                        include_granted_scopes:
                            true,

                        prompt:
                            "consent",

                        state
                    });

            res.redirect(url);
        }
    );

    app.get(
        "/auth/google/callback",
        async (req, res) => {
            try {
                const {
                    code,
                    state,
                    error
                } = req.query;

                if (error) {
                    return res
                        .status(400)
                        .send(
                            `Google OAuth Error: ${error}`
                        );
                }

                if (!code) {
                    return res
                        .status(400)
                        .send(
                            "Authorization code not found"
                        );
                }

                if (
                    !state ||
                    state !==
                        req.session
                            .oauthState
                ) {
                    return res
                        .status(400)
                        .send(
                            "OAuth state mismatch"
                        );
                }

                delete req.session
                    .oauthState;

                const { tokens } =
                    await oauth2Client
                        .getToken(code);

                oauth2Client
                    .setCredentials(
                        tokens
                    );

                saveTokens(tokens);

                botIdentity = null;

                res.redirect(
                    "/dashboard.html#bot"
                );
            } catch (error) {
                res.status(500).send(
                    apiError(error)
                        .message
                );
            }
        }
    );

    app.get(
        "/api/state",
        async (req, res) => {
            const youtube =
                youtubeClient();

            let identity =
                botIdentity;

            if (
                youtube &&
                !identity
            ) {
                try {
                    identity =
                        await getBotIdentity(
                            youtube
                        );
                } catch (_) {}
            }

            res.json({
                success: true,

                oauthConnected:
                    Boolean(youtube),

                bot: {
                    running:
                        botRunning,

                    identity,

                    live:
                        currentLive
                },

                targetVideoId:
                    targetVideoId(),

                counters:
                    loadCounters(),

                giveaway:
                    loadGiveaway(),

                commandCount:
                    loadCommands().length,

                autoMessageCount:
                    loadAutoMessages()
                        .length
            });
        }
    );

    app.post(
        "/api/bot/start",
        async (req, res) => {
            if (botRunning) {
                return res
                    .status(409)
                    .json({
                        success: false,
                        message:
                            "BOT กำลังทำงานอยู่แล้ว"
                    });
            }

            try {
                const requestedTarget =
                    extractVideoId(
                        req.body
                            ?.targetLiveVideoId ||
                            ""
                    );

                if (
                    requestedTarget
                ) {
                    const settings =
                        loadSettings();

                    saveSettings({
                        ...settings,

                        targetLiveVideoId:
                            requestedTarget
                    });

                    pushLog(
                        "info",
                        `Start BOT with Target: ${requestedTarget}`
                    );
                }

                const youtube =
                    youtubeClient();

                if (!youtube) {
                    return res
                        .status(401)
                        .json({
                            success:
                                false,

                            message:
                                "ยังไม่ได้เชื่อม Google OAuth"
                        });
                }

                const live =
                    await getLive(
                        youtube,
                        {
                            forceDiscovery:
                                true
                        }
                    );

                if (!live) {
                    return res
                        .status(404)
                        .json({
                            success:
                                false,

                            message:
                                requestedTarget ||
                                targetVideoId()
                                    ? "เชื่อม Live ไม่ได้: ตรวจ Live URL / Video ID, เปิด Live Chat และตรวจว่าไลฟ์พร้อมใช้งาน"
                                    : "ไม่พบ Live: ถ้าเป็น Unlisted ให้ใส่ Live URL / Video ID ก่อนกด Start BOT"
                        });
                }

                currentLive =
                    live;

                startBotLoop();

                return res
                    .status(202)
                    .json({
                        success: true,

                        message:
                            `BOT กำลังเชื่อม: ${live.title}`,

                        live: {
                            videoId:
                                live.videoId,

                            title:
                                live.title
                        }
                    });
            } catch (error) {
                if (
                    isYoutubeQuotaException(
                        error
                    )
                ) {
                    currentLive =
                        null;

                    botRunning =
                        false;

                    botStopRequested =
                        false;

                    pushLog(
                        "error",
                        "YouTube API Quota หมด — Start BOT ถูกหยุดแล้ว"
                    );

                    return res
                        .status(429)
                        .json({
                            success:
                                false,

                            code:
                                "YOUTUBE_QUOTA_EXCEEDED",

                            message:
                                "YouTube API Quota หมด ตอนนี้ Start BOT ไม่ได้ กรุณารอ quota reset แล้วลองใหม่"
                        });
                }

                const api =
                    apiError(error);

                pushLog(
                    "error",
                    `START BOT FAILED | ${api.message}`
                );

                currentLive =
                    null;

                return res
                    .status(
                        Number(
                            api.status
                        ) >= 400 &&
                        Number(
                            api.status
                        ) < 600
                            ? Number(
                                  api.status
                              )
                            : 500
                    )
                    .json({
                        success:
                            false,

                        message:
                            api.message ||
                            "Start BOT ไม่สำเร็จ"
                    });
            }
        }
    );

    app.post(
        "/api/bot/stop",
        (req, res) => {
            botStopRequested =
                true;

            res.json({
                success: true,
                message:
                    "กำลัง Stop BOT"
            });
        }
    );

    app.get(
        "/bot/start",
        (req, res) => {
            if (!botRunning) {
                startBotLoop();
            }

            res.redirect(
                "/dashboard.html#bot"
            );
        }
    );

    app.get(
        "/bot/stop",
        (req, res) => {
            botStopRequested =
                true;

            res.redirect(
                "/dashboard.html#bot"
            );
        }
    );

    app.post(
        "/api/send-message",
        async (req, res) => {
            try {
                const youtube =
                    youtubeClient();

                if (!youtube) {
                    return res
                        .status(401)
                        .json({
                            success:
                                false,

                            message:
                                "ยังไม่ได้ OAuth"
                        });
                }

                const live =
                    currentLive ||
                    await getLive(
                        youtube
                    );

                if (!live) {
                    return res
                        .status(404)
                        .json({
                            success:
                                false,

                            message:
                                "ไม่พบ Active Live Chat"
                        });
                }

                const result =
                    await sendChat(
                        youtube,
                        live.liveChatId,
                        req.body
                            ?.message
                    );

                res.status(
                    result.success
                        ? 200
                        : 500
                ).json(result);
            } catch (error) {
                res.status(500).json({
                    success: false,
                    ...apiError(error)
                });
            }
        }
    );

    app.get(
        "/bot/send-test",
        async (req, res) => {
            try {
                const youtube =
                    youtubeClient();

                if (!youtube) {
                    return res
                        .status(401)
                        .json({
                            success:
                                false,

                            message:
                                "ยังไม่ได้ OAuth"
                        });
                }

                const live =
                    currentLive ||
                    await getLive(
                        youtube
                    );

                if (!live) {
                    return res
                        .status(404)
                        .json({
                            success:
                                false,

                            message:
                                "ไม่พบ Active Live Chat"
                        });
                }

                const result =
                    await sendChat(
                        youtube,
                        live.liveChatId,
                        "🤖 AMR29BOT Direct Send Test"
                    );

                res.status(
                    result.success
                        ? 200
                        : 500
                ).json(result);
            } catch (error) {
                res.status(500).json({
                    success: false,
                    ...apiError(error)
                });
            }
        }
    );

    app.get(
        "/api/live",
        (req, res) => {
            if (!currentLive) {
                return res
                    .status(404)
                    .json({
                        success: false,
                        message:
                            "BOT ยังไม่ได้เชื่อม Live — กด Start BOT ก่อน"
                    });
            }

            return res.json({
                success: true,

                live:
                    currentLive,

                messages:
                    recentLiveMessages
                        .slice(-30),

                pollingIntervalMillis:
                    livePreviewPollingInterval
            });
        }
    );

    app.get(
        "/api/commands",
        (req, res) => {
            res.json({
                success: true,
                commands:
                    loadCommands()
            });
        }
    );

    app.post(
        "/api/commands",
        (req, res) => {
            const commands =
                loadCommands();

            const command =
                sanitizeCommand(
                    req.body
                );

            if (
                !command.trigger ||
                !command.response
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Trigger และ Response ห้ามว่าง"
                    });
            }

            const settings =
                loadSettings();

            const duplicate =
                commands.some(
                    item =>
                        normalize(
                            item.trigger,
                            settings
                                .caseSensitive
                        ) ===
                        normalize(
                            command.trigger,
                            settings
                                .caseSensitive
                        )
                );

            if (duplicate) {
                return res
                    .status(409)
                    .json({
                        success: false,
                        message:
                            "Trigger นี้มีอยู่แล้ว"
                    });
            }

            commands.push(command);
            saveCommands(commands);

            pushLog(
                "success",
                `เพิ่ม Command ${command.trigger}`
            );

            res.status(201).json({
                success: true,
                command
            });
        }
    );

    app.put(
        "/api/commands/:id",
        (req, res) => {
            const commands =
                loadCommands();

            const index =
                commands.findIndex(
                    item =>
                        item.id ===
                        req.params.id
                );

            if (index < 0) {
                return res
                    .status(404)
                    .json({
                        success: false,
                        message:
                            "ไม่พบ Command"
                    });
            }

            const updated =
                sanitizeCommand(
                    req.body,
                    commands[index]
                );

            if (
                !updated.trigger ||
                !updated.response
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Trigger และ Response ห้ามว่าง"
                    });
            }

            const settings =
                loadSettings();

            const duplicate =
                commands.some(
                    (
                        item,
                        position
                    ) =>
                        position !==
                            index &&
                        normalize(
                            item.trigger,
                            settings
                                .caseSensitive
                        ) ===
                            normalize(
                                updated.trigger,
                                settings
                                    .caseSensitive
                            )
                );

            if (duplicate) {
                return res
                    .status(409)
                    .json({
                        success: false,
                        message:
                            "Trigger นี้มีอยู่แล้ว"
                    });
            }

            commands[index] =
                updated;

            saveCommands(commands);

            pushLog(
                "success",
                `แก้ Command ${updated.trigger}`
            );

            res.json({
                success: true,
                command: updated
            });
        }
    );

    app.delete(
        "/api/commands/:id",
        (req, res) => {
            const commands =
                loadCommands();

            const command =
                commands.find(
                    item =>
                        item.id ===
                        req.params.id
                );

            if (!command) {
                return res
                    .status(404)
                    .json({
                        success: false,
                        message:
                            "ไม่พบ Command"
                    });
            }

            saveCommands(
                commands.filter(
                    item =>
                        item.id !==
                        req.params.id
                )
            );

            globalCooldowns.delete(
                command.id
            );

            for (
                const key
                of userCooldowns.keys()
            ) {
                if (
                    key.startsWith(
                        `${command.id}:`
                    )
                ) {
                    userCooldowns.delete(
                        key
                    );
                }
            }

            pushLog(
                "warn",
                `ลบ Command ${command.trigger}`
            );

            res.json({
                success: true
            });
        }
    );

    app.post(
        "/api/preview-command",
        (req, res) => {
            try {
                const settings =
                    loadSettings();

                const text =
                    String(
                        req.body?.text ||
                            ""
                    ).trim();

                const userName =
                    String(
                        req.body
                            ?.userName ||
                            "Viewer"
                    ).trim() ||
                    "Viewer";

                const requestedRole =
                    String(
                        req.body?.role ||
                            "everyone"
                    );

                const currentRole =
                    [
                        "everyone",
                        "member",
                        "moderator",
                        "owner"
                    ].includes(
                        requestedRole
                    )
                        ? requestedRole
                        : "everyone";

                const points =
                    Math.max(
                        0,
                        Number(
                            req.body
                                ?.points ||
                                0
                        )
                    );

                const activeMinutes =
                    Math.max(
                        0,
                        Number(
                            req.body
                                ?.activeMinutes ||
                                0
                        )
                    );

                const liveTitle =
                    String(
                        req.body
                            ?.liveTitle ||
                        currentLive
                            ?.title ||
                        "AMR29 Live"
                    );

                if (!text) {
                    return res
                        .status(400)
                        .json({
                            success:
                                false,

                            message:
                                "พิมพ์ Command ก่อน"
                        });
                }

                for (
                    const command
                    of loadCommands()
                ) {
                    const match =
                        matchCustom(
                            text,
                            command,
                            settings
                        );

                    if (
                        !match.matched
                    ) {
                        continue;
                    }

                    const requiredRole =
                        command.minRole ||
                        "everyone";

                    const enabled =
                        command.enabled !==
                        false;

                    const permissionAllowed =
                        roleAllowed(
                            currentRole,
                            requiredRole
                        );

                    const selected =
                        pickResponse(
                            command.response
                        );

                    const rendered =
                        renderTemplate(
                            selected,
                            {
                                user:
                                    userName,

                                args:
                                    match.args,

                                command:
                                    command.trigger,

                                liveTitle,

                                points:
                                    Math.floor(
                                        points
                                    ),

                                watchtime:
                                    formatDuration(
                                        activeMinutes
                                    )
                            }
                        );

                    return res.json({
                        success: true,

                        matched: true,

                        previewAllowed:
                            true,

                        liveAllowed:
                            enabled &&
                            permissionAllowed,

                        liveReason:
                            !enabled
                                ? "disabled"
                                : !permissionAllowed
                                ? "permission"
                                : null,

                        command:
                            command.trigger,

                        commandName:
                            command.name ||
                            command.trigger,

                        commandType:
                            "custom",

                        commandEnabled:
                            enabled,

                        requiredRole,

                        currentRole,

                        permissionAllowed,

                        aliases:
                            command.aliases ||
                            [],

                        args:
                            match.args,

                        responseTemplate:
                            command.response,

                        response:
                            rendered
                    });
                }

                return res.json({
                    success: true,
                    matched: false,
                    input: text,
                    message:
                        "ไม่พบ Command นี้ใน Dashboard"
                });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    ...apiError(error)
                });
            }
        }
    );

    app.get(
        "/api/automessages",
        (req, res) => {
            res.json({
                success: true,
                items:
                    loadAutoMessages()
            });
        }
    );

    app.post(
        "/api/automessages",
        (req, res) => {
            const list =
                loadAutoMessages();

            const item = {
                id:
                    crypto.randomUUID(),

                name:
                    String(
                        req.body?.name ||
                            "Auto Message"
                    ).trim(),

                text:
                    String(
                        req.body?.text ||
                            ""
                    ).trim(),

                intervalMinutes:
                    clamp(
                        req.body
                            ?.intervalMinutes,
                        1,
                        1440,
                        10
                    ),

                enabled:
                    req.body?.enabled !==
                    false
            };

            if (!item.text) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "ข้อความห้ามว่าง"
                    });
            }

            list.push(item);
            saveAutoMessages(list);

            res.status(201).json({
                success: true,
                item
            });
        }
    );

    app.put(
        "/api/automessages/:id",
        (req, res) => {
            const list =
                loadAutoMessages();

            const index =
                list.findIndex(
                    item =>
                        item.id ===
                        req.params.id
                );

            if (index < 0) {
                return res
                    .status(404)
                    .json({
                        success: false,
                        message:
                            "ไม่พบ Auto Message"
                    });
            }

            const old =
                list[index];

            const item = {
                ...old,

                name:
                    String(
                        req.body?.name ??
                            old.name
                    ).trim(),

                text:
                    String(
                        req.body?.text ??
                            old.text
                    ).trim(),

                intervalMinutes:
                    clamp(
                        req.body
                            ?.intervalMinutes ??
                            old.intervalMinutes,
                        1,
                        1440,
                        10
                    ),

                enabled:
                    typeof req.body
                        ?.enabled ===
                    "boolean"
                        ? req.body
                              .enabled
                        : old.enabled
            };

            if (!item.text) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "ข้อความห้ามว่าง"
                    });
            }

            list[index] = item;

            saveAutoMessages(list);

            res.json({
                success: true,
                item
            });
        }
    );

    app.delete(
        "/api/automessages/:id",
        (req, res) => {
            const list =
                loadAutoMessages();

            saveAutoMessages(
                list.filter(
                    item =>
                        item.id !==
                        req.params.id
                )
            );

            autoLastSent.delete(
                req.params.id
            );

            res.json({
                success: true
            });
        }
    );

    app.get(
        "/api/counters",
        (req, res) => {
            res.json({
                success: true,
                counters:
                    loadCounters()
            });
        }
    );

    app.post(
        "/api/counters",
        (req, res) => {
            const counters =
                loadCounters();

            switch (
                req.body?.action
            ) {
                case "win+":
                    counters.wins++;
                    break;

                case "win-":
                    counters.wins =
                        Math.max(
                            0,
                            counters.wins -
                                1
                        );
                    break;

                case "lose+":
                    counters.losses++;
                    break;

                case "lose-":
                    counters.losses =
                        Math.max(
                            0,
                            counters.losses -
                                1
                        );
                    break;

                case "reset":
                    counters.wins =
                        0;
                    counters.losses =
                        0;
                    break;

                default:
                    return res
                        .status(400)
                        .json({
                            success:
                                false,
                            message:
                                "Unknown counter action"
                        });
            }

            saveCounters(
                counters
            );

            res.json({
                success: true,
                counters
            });
        }
    );

    app.get(
        "/api/quotes",
        (req, res) => {
            res.json({
                success: true,
                quotes:
                    loadQuotes()
            });
        }
    );

    app.post(
        "/api/quotes",
        (req, res) => {
            const text =
                String(
                    req.body?.text ||
                        ""
                ).trim();

            if (!text) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Quote ห้ามว่าง"
                    });
            }

            const quotes =
                loadQuotes();

            const number =
                quotes.length
                    ? Math.max(
                          ...quotes.map(
                              item =>
                                  Number(
                                      item.number
                                  ) || 0
                          )
                      ) + 1
                    : 1;

            const item = {
                id:
                    crypto.randomUUID(),

                number,

                text,

                addedBy:
                    "Dashboard",

                createdAt:
                    new Date()
                        .toISOString()
            };

            quotes.push(item);
            saveQuotes(quotes);

            res.status(201).json({
                success: true,
                item
            });
        }
    );

    app.delete(
        "/api/quotes/:id",
        (req, res) => {
            saveQuotes(
                loadQuotes().filter(
                    item =>
                        item.id !==
                        req.params.id
                )
            );

            res.json({
                success: true
            });
        }
    );

    app.get(
        "/api/users",
        (req, res) => {
            const users =
                Object.values(
                    loadUsers()
                ).sort(
                    (a, b) =>
                        (b.points ||
                            0) -
                        (a.points ||
                            0)
                );

            res.json({
                success: true,
                users
            });
        }
    );

    app.post(
        "/api/users/:channelId/points",
        (req, res) => {
            const users =
                loadUsers();

            const user =
                users[
                    req.params
                        .channelId
                ];

            if (!user) {
                return res
                    .status(404)
                    .json({
                        success: false,
                        message:
                            "ไม่พบ User"
                    });
            }

            user.points =
                Math.max(
                    0,
                    Number(
                        user.points || 0
                    ) +
                        clamp(
                            req.body
                                ?.delta,
                            -100000,
                            100000,
                            0
                        )
                );

            users[
                req.params.channelId
            ] = user;

            saveUsers(users);

            res.json({
                success: true,
                user
            });
        }
    );

    app.get(
        "/api/giveaway",
        (req, res) => {
            res.json({
                success: true,
                giveaway:
                    loadGiveaway()
            });
        }
    );

    app.post(
        "/api/giveaway/start",
        (req, res) => {
            const giveaway = {
                active: true,

                title:
                    String(
                        req.body?.title ||
                            "Giveaway"
                    ).trim(),

                keyword:
                    String(
                        req.body
                            ?.keyword ||
                            "!join"
                    ).trim() ||
                    "!join",

                winnerCount:
                    clamp(
                        req.body
                            ?.winnerCount,
                        1,
                        20,
                        1
                    ),

                entrants: [],

                startedAt:
                    new Date()
                        .toISOString(),

                lastWinners: []
            };

            saveGiveaway(
                giveaway
            );

            res.json({
                success: true,
                giveaway
            });
        }
    );

    app.post(
        "/api/giveaway/stop",
        (req, res) => {
            const giveaway =
                loadGiveaway();

            giveaway.active =
                false;

            saveGiveaway(
                giveaway
            );

            res.json({
                success: true,
                giveaway
            });
        }
    );

    app.post(
        "/api/giveaway/reset",
        (req, res) => {
            const giveaway =
                clone(
                    DEFAULTS.giveaway
                );

            saveGiveaway(
                giveaway
            );

            res.json({
                success: true,
                giveaway
            });
        }
    );

    app.post(
        "/api/giveaway/draw",
        async (req, res) => {
            try {
                const youtube =
                    youtubeClient();

                const live =
                    youtube
                        ? currentLive ||
                          await getLive(
                              youtube
                          )
                        : null;

                const result =
                    await drawGiveaway(
                        youtube,
                        live?.liveChatId ||
                            null
                    );

                res.status(
                    result.success
                        ? 200
                        : 400
                ).json(result);
            } catch (error) {
                res.status(500).json({
                    success: false,
                    ...apiError(error)
                });
            }
        }
    );

    async function moderationContext() {
        const youtube =
            youtubeClient();

        if (!youtube) {
            throw new Error(
                "ยังไม่ได้ OAuth"
            );
        }

        const live =
            currentLive ||
            await getLive(
                youtube
            );

        if (!live) {
            throw new Error(
                "ไม่พบ Active Live Chat"
            );
        }

        return {
            youtube,
            live
        };
    }

    app.post(
        "/api/mod/delete-message",
        async (req, res) => {
            try {
                const { youtube } =
                    await moderationContext();

                const messageId =
                    String(
                        req.body
                            ?.messageId ||
                            ""
                    ).trim();

                if (!messageId) {
                    return res
                        .status(400)
                        .json({
                            success:
                                false,
                            message:
                                "messageId ห้ามว่าง"
                        });
                }

                await youtube
                    .liveChatMessages
                    .delete({
                        id:
                            messageId
                    });

                pushLog(
                    "warn",
                    `Moderator deleted message ${messageId}`
                );

                res.json({
                    success: true
                });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    ...apiError(error)
                });
            }
        }
    );

    app.post(
        "/api/mod/timeout",
        async (req, res) => {
            try {
                const {
                    youtube,
                    live
                } =
                    await moderationContext();

                const channelId =
                    String(
                        req.body
                            ?.channelId ||
                            ""
                    ).trim();

                const seconds =
                    clamp(
                        req.body
                            ?.seconds,
                        1,
                        86400,
                        300
                    );

                if (!channelId) {
                    return res
                        .status(400)
                        .json({
                            success:
                                false,
                            message:
                                "channelId ห้ามว่าง"
                        });
                }

                const response =
                    await youtube
                        .liveChatBans
                        .insert({
                            part: [
                                "snippet"
                            ],

                            requestBody:
                                {
                                    snippet:
                                        {
                                            liveChatId:
                                                live.liveChatId,

                                            type:
                                                "temporary",

                                            banDurationSeconds:
                                                seconds,

                                            bannedUserDetails:
                                                {
                                                    channelId
                                                }
                                        }
                                }
                        });

                pushLog(
                    "warn",
                    `Timeout ${channelId} ${seconds}s`
                );

                res.json({
                    success: true,

                    banId:
                        response.data
                            ?.id ||
                        null
                });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    ...apiError(error)
                });
            }
        }
    );

    app.post(
        "/api/mod/ban",
        async (req, res) => {
            try {
                const {
                    youtube,
                    live
                } =
                    await moderationContext();

                const channelId =
                    String(
                        req.body
                            ?.channelId ||
                            ""
                    ).trim();

                if (!channelId) {
                    return res
                        .status(400)
                        .json({
                            success:
                                false,
                            message:
                                "channelId ห้ามว่าง"
                        });
                }

                const response =
                    await youtube
                        .liveChatBans
                        .insert({
                            part: [
                                "snippet"
                            ],

                            requestBody:
                                {
                                    snippet:
                                        {
                                            liveChatId:
                                                live.liveChatId,

                                            type:
                                                "permanent",

                                            bannedUserDetails:
                                                {
                                                    channelId
                                                }
                                        }
                                }
                        });

                pushLog(
                    "warn",
                    `Permanent ban ${channelId}`
                );

                res.json({
                    success: true,

                    banId:
                        response.data
                            ?.id ||
                        null
                });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    ...apiError(error)
                });
            }
        }
    );

    app.get(
        "/api/settings",
        (req, res) => {
            res.json({
                success: true,
                settings:
                    loadSettings()
            });
        }
    );

    app.put(
        "/api/settings",
        (req, res) => {
            const old =
                loadSettings();

            const body =
                req.body || {};

            const next = {
                ...old,

                botName:
                    String(
                        body.botName ??
                            old.botName
                    ).trim(),

                targetLiveVideoId:
                    extractVideoId(
                        body.targetLiveVideoId ??
                            old.targetLiveVideoId
                    ),

                caseSensitive:
                    typeof body
                        .caseSensitive ===
                    "boolean"
                        ? body.caseSensitive
                        : old.caseSensitive,

                ignoreBotMessages:
                    typeof body
                        .ignoreBotMessages ===
                    "boolean"
                        ? body.ignoreBotMessages
                        : old.ignoreBotMessages,

                logChatMessages:
                    typeof body
                        .logChatMessages ===
                    "boolean"
                        ? body.logChatMessages
                        : old.logChatMessages,

                autoStart:
                    typeof body
                        .autoStart ===
                    "boolean"
                        ? body.autoStart
                        : old.autoStart,

                welcomeEnabled:
                    typeof body
                        .welcomeEnabled ===
                    "boolean"
                        ? body.welcomeEnabled
                        : old.welcomeEnabled,

                welcomeMessage:
                    String(
                        body.welcomeMessage ??
                            old.welcomeMessage
                    ),

                pointsEnabled:
                    typeof body
                        .pointsEnabled ===
                    "boolean"
                        ? body.pointsEnabled
                        : old.pointsEnabled,

                pointsPerMessage:
                    clamp(
                        body.pointsPerMessage ??
                            old.pointsPerMessage,
                        0,
                        1000,
                        2
                    ),

                pointsCooldownSeconds:
                    clamp(
                        body.pointsCooldownSeconds ??
                            old.pointsCooldownSeconds,
                        0,
                        3600,
                        60
                    ),

                activeWindowMinutes:
                    clamp(
                        body.activeWindowMinutes ??
                            old.activeWindowMinutes,
                        1,
                        30,
                        5
                    ),

                maxResponseLength:
                    clamp(
                        body.maxResponseLength ??
                            old.maxResponseLength,
                        1,
                        200,
                        200
                    )
            };

            saveSettings(next);

            pushLog(
                "success",
                "บันทึก Bot Settings แล้ว"
            );

            res.json({
                success: true,
                settings: next
            });
        }
    );

    app.get(
        "/api/logs",
        (req, res) => {
            const limit =
                clamp(
                    req.query?.limit,
                    1,
                    300,
                    150
                );

            res.json({
                success: true,

                logs:
                    runtimeLogs.slice(
                        -limit
                    )
            });
        }
    );

    app.delete(
        "/api/logs",
        (req, res) => {
            runtimeLogs.splice(
                0,
                runtimeLogs.length
            );

            res.json({
                success: true
            });
        }
    );

    let autoStartScheduled =
        false;

    return {
        startAuto() {
            if (
                autoStartScheduled
            ) {
                return;
            }

            autoStartScheduled =
                true;

            if (
                loadSettings()
                    .autoStart &&
                loadTokens()
            ) {
                setTimeout(
                    () => {
                        if (
                            !botRunning
                        ) {
                            startBotLoop();
                        }
                    },
                    2500
                );
            }
        },

        stop() {
            botStopRequested =
                true;
        }
    };
}

const botIntegration =
    installYouTubeBot(
        app,
        {
            publicDir:
                PUBLIC_DIR
        }
    );

async function gracefulShutdown(
    signal
) {
    try {
        botIntegration.stop();
    } catch (_) {}

    if (isShuttingDown) {
        return;
    }

    isShuttingDown = true;

    console.log(
        `\n${signal} received - shutting down...`
    );

    if (cleanupInterval) {
        clearInterval(
            cleanupInterval
        );
    }

    const forceTimer =
        setTimeout(
            () => {
                console.error(
                    "Forced shutdown after timeout"
                );

                process.exit(1);
            },
            10000
        );

    forceTimer.unref();

    server.close(
        async error => {
            if (error) {
                console.error(
                    "HTTP server close error:",
                    error
                );
            }

            await closeDatabase();

            process.exit(
                error ? 1 : 0
            );
        }
    );
}

process.on(
    "SIGTERM",
    () =>
        gracefulShutdown(
            "SIGTERM"
        )
);

process.on(
    "SIGINT",
    () =>
        gracefulShutdown(
            "SIGINT"
        )
);

async function start() {
    try {
        validateRuntimeConfig();

        await initDatabase();

        await dbGet(
            "SELECT 1 AS ok"
        );

        console.log(
            "PostgreSQL connected ✓"
        );

        await cleanupMobileSessions();

        await recoverMobileSessions();

        await cleanupCustomSounds();

        cleanupInterval =
            setInterval(
                () => {
                    cleanupMobileSessions()
                        .catch(error =>
                            console.error(
                                "Mobile cleanup interval:",
                                error
                            )
                        );

                    cleanupCustomSounds()
                        .catch(error =>
                            console.error(
                                "Custom sound cleanup interval:",
                                error
                            )
                        );
                },
                60 * 1000
            );

        cleanupInterval.unref?.();

        server.listen(
            PORT,
            "0.0.0.0",
            () => {
                botIntegration.startAuto();

                const baseUrl =
                    PUBLIC_BASE_URL ||
                    `http://localhost:${PORT}`;

                console.log(
                    "\n======================================="
                );

                console.log(
                    "   AMR29 DONATE + YOUTUBE BOT"
                );

                console.log(
                    "======================================="
                );

                console.log(
                    "Environment:",
                    APP_ENV
                );

                console.log(
                    "Version:",
                    APP_VERSION
                );

                console.log(
                    "Public Dir:",
                    PUBLIC_DIR
                );

                console.log(
                    "Data Dir:",
                    DATA_DIR
                );

                console.log(
                    "Database: Supabase PostgreSQL"
                );

                console.log("");

                console.log(
                    `Donate:        ${baseUrl}`
                );

                console.log(
                    `Dashboard:     ${baseUrl}/dashboard.html`
                );

                console.log(
                    `OBS Overlay:   ${baseUrl}/overlay.html`
                );

                console.log(
                    `Goal Overlay:  ${baseUrl}/goal-overlay.html`
                );

                console.log(
                    `Health:        ${baseUrl}/health`
                );

                console.log(
                    `Version API:   ${baseUrl}/api/version`
                );

                console.log("");

                console.log(
                    "ADMIN_KEY:",
                    process.env.ADMIN_KEY
                        ? "Loaded ✓"
                        : "NOT SET ✗"
                );

                console.log(
                    "PROMPTPAY_ID:",
                    process.env.PROMPTPAY_ID
                        ? "Loaded ✓"
                        : "NOT SET ✗"
                );

                console.log(
                    "EASYSLIP:",
                    process.env
                        .EASYSLIP_API_KEY
                        ? "Loaded ✓"
                        : "NOT SET ✗"
                );

                console.log(
                    "PUBLIC_BASE_URL:",
                    PUBLIC_BASE_URL ||
                        "Not set"
                );

                console.log(
                    "DATABASE_URL:",
                    DATABASE_URL
                        ? "Loaded ✓"
                        : "NOT SET ✗"
                );

                console.log(
                    "======================================="
                );
            }
        );
    } catch (error) {
        console.error(
            "Server startup failed:",
            error
        );

        process.exit(1);
    }
}

start();