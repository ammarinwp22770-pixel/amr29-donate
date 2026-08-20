const { Pool } = require("pg");
require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const generatePayload = require("promptpay-qr");
const multer = require("multer");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

/* =========================================================
   CONFIG
========================================================= */

const ALLOWED_ENVIRONMENTS = [
    "development",
    "staging",
    "production"
];

const APP_ENV = String(
    process.env.APP_ENV ||
    process.env.NODE_ENV ||
    "development"
)
    .trim()
    .toLowerCase();

if (
    !ALLOWED_ENVIRONMENTS.includes(
        APP_ENV
    )
) {
    throw new Error(
        `APP_ENV ไม่ถูกต้อง: ${APP_ENV} (ใช้ development, staging หรือ production)`
    );
}

const IS_DEVELOPMENT =
    APP_ENV ===
    "development";

const IS_PRODUCTION =
    APP_ENV ===
    "production";

const IS_DEPLOYED =
    APP_ENV === "staging" ||
    APP_ENV === "production";

const PORT =
    Number(
        process.env.PORT
    )
    ||
    3000;

const APP_VERSION =
    String(
        process.env.APP_VERSION ||
        "dev"
    )
        .trim();

const PUBLIC_BASE_URL =
    String(
        process.env.PUBLIC_BASE_URL ||
        ""
    )
        .trim()
        .replace(
            /\/+$/,
            ""
        );

const DATABASE_URL =
    String(
        process.env.DATABASE_URL ||
        ""
    )
        .trim();

const DATABASE_SSL =
    String(
        process.env.DATABASE_SSL ||
        "true"
    )
        .trim()
        .toLowerCase()
    !==
    "false";

const DATA_DIR =
    path.resolve(
        __dirname,
        String(
            process.env.DATA_DIR ||
            path.join(
                "data",
                APP_ENV
            )
        )
    );

const PUBLIC_DIR_CANDIDATE =
    path.resolve(
        __dirname,
        String(
            process.env.PUBLIC_DIR ||
            "public"
        )
    );

const PUBLIC_DIR =
    fs.existsSync(
        PUBLIC_DIR_CANDIDATE
    )
        ?
        PUBLIC_DIR_CANDIDATE
        :
        (
            IS_DEVELOPMENT
                ?
                __dirname
                :
                PUBLIC_DIR_CANDIDATE
        );

const LEGACY_STATIC_MODE =
    PUBLIC_DIR ===
    __dirname;

const MOBILE_SESSION_TTL_MS =
    15 *
    60 *
    1000;

const CUSTOM_SOUND_MIN_AMOUNT =
    100;

const CUSTOM_SOUND_MAX_BYTES =
    3 *
    1024 *
    1024;

const CUSTOM_SOUND_TTL_MS =
    30 *
    60 *
    1000;

const CUSTOM_SOUND_AFTER_USE_TTL_MS =
    15 *
    60 *
    1000;

const CUSTOM_SOUND_DIR =
    path.join(
        DATA_DIR,
        "custom-audio"
    );

const VIDEO_DONATION_MIN_AMOUNT =
    10;

const VIDEO_DONATION_MAX_DURATION =
    20;

const VIDEO_DONATION_MAX_START =
    12 *
    60 *
    60;

fs.mkdirSync(
    DATA_DIR,
    {
        recursive: true
    }
);

fs.mkdirSync(
    CUSTOM_SOUND_DIR,
    {
        recursive: true
    }
);

function validateRuntimeConfig() {

    const required = [
        "DATABASE_URL"
    ];

    if (
        IS_DEPLOYED
    ) {
        required.push(
            "ADMIN_KEY",
            "PROMPTPAY_ID",
            "EASYSLIP_API_KEY",
            "PUBLIC_BASE_URL"
        );
    }

    const missing =
        required.filter(
            key =>
                !String(
                    process.env[key] ||
                    ""
                )
                    .trim()
        );

    if (
        missing.length
    ) {
        throw new Error(
            `Environment variables ไม่ครบ: ${missing.join(", ")}`
        );
    }

    if (
        IS_DEPLOYED
        &&
        !PUBLIC_BASE_URL.startsWith(
            "https://"
        )
    ) {
        throw new Error(
            "PUBLIC_BASE_URL ของ staging/production ต้องเป็น HTTPS"
        );
    }

    if (
        IS_DEPLOYED
        &&
        !fs.existsSync(
            PUBLIC_DIR_CANDIDATE
        )
    ) {
        throw new Error(
            `ไม่พบ public directory: ${PUBLIC_DIR_CANDIDATE}`
        );
    }
}

/* =========================================================
   EXPRESS / STATIC
========================================================= */

app.disable(
    "x-powered-by"
);

if (
    IS_DEPLOYED
) {
    app.set(
        "trust proxy",
        1
    );
}

app.use(
    (
        req,
        res,
        next
    ) => {

        res.setHeader(
            "X-Content-Type-Options",
            "nosniff"
        );

        res.setHeader(
            "Referrer-Policy",
            "strict-origin-when-cross-origin"
        );

        res.setHeader(
            "Permissions-Policy",
            "camera=(), microphone=(), geolocation=()"
        );

        res.setHeader(
            "X-AMR29-Environment",
            APP_ENV
        );

        res.setHeader(
            "X-AMR29-Version",
            APP_VERSION
        );

        next();
    }
);

app.use(
    express.json({
        limit:
            "1mb"
    })
);

app.use(
    express.urlencoded({
        extended:
            true,

        limit:
            "1mb"
    })
);

if (
    LEGACY_STATIC_MODE
) {

    const blockedExact =
        new Set([
            "/server.js",
            "/package.json",
            "/package-lock.json",
            "/donations.db",
            "/.env"
        ]);

    const blockedPrefixes = [
        "/data/",
        "/.amr29-private/",
        "/.git/",
        "/node_modules/"
    ];

    app.use(
        (
            req,
            res,
            next
        ) => {

            const lower =
                decodeURIComponent(
                    String(
                        req.path ||
                        ""
                    )
                )
                    .toLowerCase();

            if (
                blockedExact.has(
                    lower
                )
                ||
                blockedPrefixes.some(
                    prefix =>
                        lower.startsWith(
                            prefix
                        )
                )
                ||
                lower.endsWith(
                    ".db"
                )
                ||
                lower.endsWith(
                    ".db-journal"
                )
                ||
                lower.endsWith(
                    ".sqlite"
                )
                ||
                lower.endsWith(
                    ".sqlite3"
                )
            ) {
                return res
                    .status(
                        404
                    )
                    .send(
                        "Not Found"
                    );
            }

            next();
        }
    );
}

app.use(
    express.static(
        PUBLIC_DIR,
        {
            dotfiles:
                "ignore",

            etag:
                true,

            maxAge:
                IS_PRODUCTION
                    ?
                    "1h"
                    :
                    0,

            setHeaders(
                res,
                filePath
            ) {

                if (
                    filePath
                        .toLowerCase()
                        .endsWith(
                            ".html"
                        )
                ) {
                    res.setHeader(
                        "Cache-Control",
                        "no-store, no-cache, must-revalidate"
                    );
                }

                else if (
                    !IS_PRODUCTION
                ) {
                    res.setHeader(
                        "Cache-Control",
                        "no-store"
                    );
                }
            }
        }
    )
);

app.get(
    "/health",
    (
        req,
        res
    ) => {

        res.json({
            success:
                true,

            service:
                "amr29-donate",

            environment:
                APP_ENV,

            version:
                APP_VERSION,

            uptime:
                Math.floor(
                    process.uptime()
                ),

            timestamp:
                new Date()
                    .toISOString()
        });
    }
);

app.get(
    "/api/version",
    (
        req,
        res
    ) => {

        res.json({
            success:
                true,

            environment:
                APP_ENV,

            version:
                APP_VERSION
        });
    }
);

/* =========================================================
   SUPABASE POSTGRESQL
========================================================= */

if (
    !DATABASE_URL
) {
    throw new Error(
        "ยังไม่ได้ตั้ง DATABASE_URL สำหรับ Supabase PostgreSQL"
    );
}

const pool =
    new Pool({
        connectionString:
            DATABASE_URL,

        ssl:
            DATABASE_SSL
                ?
                {
                    rejectUnauthorized:
                        false
                }
                :
                false,

        max:
            5,

        idleTimeoutMillis:
            30000,

        connectionTimeoutMillis:
            10000
    });

pool.on(
    "error",
    error => {
        console.error(
            "PostgreSQL Pool Error:",
            error
        );
    }
);

function toPostgresSql(
    sql
) {

    let index =
        0;

    return String(
        sql
    )
        .replace(
            /\?/g,
            () =>
                `$${++index}`
        );
}

async function dbRun(
    sql,
    params = [],
    executor = pool
) {

    const result =
        await executor.query(
            toPostgresSql(
                sql
            ),
            params
        );

    return {
        lastID:
            result.rows?.[0]?.id
            ??
            null,

        changes:
            Number(
                result.rowCount ||
                0
            ),

        rows:
            result.rows ||
            []
    };
}

async function dbGet(
    sql,
    params = [],
    executor = pool
) {

    const result =
        await executor.query(
            toPostgresSql(
                sql
            ),
            params
        );

    return result.rows?.[0]
        ||
        null;
}

async function dbAll(
    sql,
    params = [],
    executor = pool
) {

    const result =
        await executor.query(
            toPostgresSql(
                sql
            ),
            params
        );

    return result.rows
        ||
        [];
}

/* =========================================================
   SETTINGS / DB INIT
========================================================= */

const defaultSettings = {

    goal_title:
        "เป้าหมายสนับสนุน",

    goal_target:
        "5000",

    goal_enabled:
        "1",

    goal_base_total:
        "0",

    alert_tts_enabled:
        "1",

    alert_read_message:
        "1",

    alert_tts_rate:
        "1",

    alert_big_amount:
        "500",

    alert_mega_amount:
        "1000",

    alert_after_tts_delay:
        "1000",

    alert_no_tts_display_time:
        "4500",

    alert_sound_volume:
        "70",

    alert_custom_sound_volume:
        "70",

    alert_tts_volume:
        "100",

    alert_video_volume:
        "80",

    alert_master_volume:
        "100",

    alert_sound_muted:
        "0",

    alert_custom_sound_muted:
        "0",

    alert_tts_muted:
        "0",

    alert_video_muted:
        "0",

    alert_tts_pitch:
        "1",

    alert_tts_voice_uri:
        "auto",

    alert_tts_voice_name:
        "",

    alert_tts_lang:
        "th-TH"
};

async function ensureColumn(
    tableName,
    columnName,
    definition
) {

    const safe =
        /^[A-Za-z_][A-Za-z0-9_]*$/;

    if (
        !safe.test(
            tableName
        )
        ||
        !safe.test(
            columnName
        )
    ) {
        throw new Error(
            "Database identifier ไม่ถูกต้อง"
        );
    }

    await dbRun(
        `
        ALTER TABLE ${tableName}
        ADD COLUMN IF NOT EXISTS ${columnName}
        ${definition}
        `
    );
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

    await ensureColumn(
        "donations",
        "video_url",
        "TEXT"
    );

    await ensureColumn(
        "donations",
        "video_id",
        "TEXT"
    );

    await ensureColumn(
        "donations",
        "video_start",
        "INTEGER"
    );

    await ensureColumn(
        "donations",
        "video_duration",
        "INTEGER"
    );

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

    await ensureColumn(
        "mobile_sessions",
        "custom_sound_token",
        "TEXT"
    );

    await ensureColumn(
        "mobile_sessions",
        "video_url",
        "TEXT"
    );

    await ensureColumn(
        "mobile_sessions",
        "video_id",
        "TEXT"
    );

    await ensureColumn(
        "mobile_sessions",
        "video_start",
        "INTEGER"
    );

    await ensureColumn(
        "mobile_sessions",
        "video_duration",
        "INTEGER"
    );

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

    for (
        const [
            key,
            value
        ]
        of Object.entries(
            defaultSettings
        )
    ) {

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
            [
                key,
                value
            ]
        );
    }
}

async function getSettings() {

    const rows =
        await dbAll(`
            SELECT
                key,
                value
            FROM settings
        `);

    const settings = {
        ...defaultSettings
    };

    for (
        const row
        of rows
    ) {
        settings[
            row.key
        ] =
            row.value;
    }

    return settings;
}

async function setSetting(
    key,
    value
) {

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
        [
            key,
            String(
                value
            )
        ]
    );
}

function toBoolean(
    value
) {

    return (
        value === true
        ||
        value === 1
        ||
        value === "1"
        ||
        value === "true"
    );
}

function clamp(
    value,
    min,
    max
) {

    return Math.min(
        max,
        Math.max(
            min,
            value
        )
    );
}

function normalizeVolumeValue(
    value,
    fallback
) {

    if (
        value === undefined
        ||
        value === null
        ||
        value === ""
    ) {
        return clamp(
            Math.round(
                Number(
                    fallback
                )
                ||
                0
            ),
            0,
            100
        );
    }

    const number =
        Number(
            value
        );

    if (
        !Number.isFinite(
            number
        )
        ||
        number < 0
        ||
        number > 100
    ) {
        throw new Error(
            "Volume ต้องอยู่ระหว่าง 0 - 100"
        );
    }

    return Math.round(
        number
    );
}

async function getAlertSettings() {

    const s =
        await getSettings();

    const numberOr =
        (
            value,
            fallback
        ) => {

            const n =
                Number(
                    value
                );

            return Number.isFinite(
                n
            )
                ?
                n
                :
                fallback;
        };

    return {

        ttsEnabled:
            s.alert_tts_enabled ===
            "1",

        readMessage:
            s.alert_read_message ===
            "1",

        ttsRate:
            numberOr(
                s.alert_tts_rate,
                1
            ),

        bigAmount:
            numberOr(
                s.alert_big_amount,
                500
            ),

        megaAmount:
            numberOr(
                s.alert_mega_amount,
                1000
            ),

        afterTtsDelay:
            numberOr(
                s.alert_after_tts_delay,
                1000
            ),

        noTtsDisplayTime:
            numberOr(
                s.alert_no_tts_display_time,
                4500
            ),

        alertVolume:
            clamp(
                numberOr(
                    s.alert_sound_volume,
                    70
                ),
                0,
                100
            ),

        customSoundVolume:
            clamp(
                numberOr(
                    s.alert_custom_sound_volume,
                    70
                ),
                0,
                100
            ),

        ttsVolume:
            clamp(
                numberOr(
                    s.alert_tts_volume,
                    100
                ),
                0,
                100
            ),

        videoVolume:
            clamp(
                numberOr(
                    s.alert_video_volume,
                    80
                ),
                0,
                100
            ),

        masterVolume:
            clamp(
                numberOr(
                    s.alert_master_volume,
                    100
                ),
                0,
                100
            ),

        alertMuted:
            s.alert_sound_muted ===
            "1",

        customSoundMuted:
            s.alert_custom_sound_muted ===
            "1",

        ttsMuted:
            s.alert_tts_muted ===
            "1",

        videoMuted:
            s.alert_video_muted ===
            "1",

        ttsPitch:
            clamp(
                numberOr(
                    s.alert_tts_pitch,
                    1
                ),
                0.5,
                2
            ),

        ttsVoiceURI:
            String(
                s.alert_tts_voice_uri
                ||
                "auto"
            ),

        ttsVoiceName:
            String(
                s.alert_tts_voice_name
                ||
                ""
            ),

        ttsLang:
            String(
                s.alert_tts_lang
                ||
                "th-TH"
            )
    };
}

async function emitAlertSettingsUpdate() {

    try {

        io.emit(
            "alert-settings-update",
            await getAlertSettings()
        );

    } catch (
        error
    ) {

        console.error(
            "Emit Alert Settings Error:",
            error
        );
    }
}

/* =========================================================
   DONATION DATA / GOAL
========================================================= */

async function getAllDonationTotal() {

    const row =
        await dbGet(`
            SELECT
                COALESCE(
                    SUM(amount),
                    0
                )
                AS total
            FROM donations
        `);

    return Number(
        row?.total
        ||
        0
    );
}

async function getTopDonorsFromDB() {

    const rows =
        await dbAll(`
            SELECT
                name,
                SUM(amount) AS amount

            FROM donations

            GROUP BY name

            ORDER BY amount DESC

            LIMIT 3
        `);

    return rows.map(
        row => ({
            name:
                row.name,

            amount:
                Number(
                    row.amount
                    ||
                    0
                )
        })
    );
}

async function getDonationGoal() {

    const settings =
        await getSettings();

    const allTimeTotal =
        await getAllDonationTotal();

    const target =
        Math.max(
            1,
            Number(
                settings.goal_target
                ||
                5000
            )
        );

    const baseTotal =
        Math.max(
            0,
            Number(
                settings.goal_base_total
                ||
                0
            )
        );

    const total =
        Math.max(
            0,
            allTimeTotal -
            baseTotal
        );

    const percent =
        Math.min(
            100,
            Math.max(
                0,
                Math.round(
                    (
                        total /
                        target
                    )
                    *
                    100
                )
            )
        );

    return {

        title:
            settings.goal_title
            ||
            "เป้าหมายสนับสนุน",

        target,

        total,

        percent,

        enabled:
            settings.goal_enabled ===
            "1"
    };
}

async function emitGoalUpdate() {

    io.emit(
        "goal-update",
        await getDonationGoal()
    );
}

/* =========================================================
   ADMIN AUTH / SOCKET
========================================================= */

function requireAdminKey(
    req,
    res,
    next
) {

    const expected =
        String(
            process.env.ADMIN_KEY
            ||
            ""
        )
            .trim();

    const received =
        String(
            req.headers[
                "x-admin-key"
            ]
            ||
            ""
        )
            .trim();

    if (
        !expected
    ) {
        return res
            .status(
                500
            )
            .json({
                success:
                    false,

                message:
                    "ยังไม่ได้ตั้ง ADMIN_KEY ใน .env"
            });
    }

    if (
        received !==
        expected
    ) {
        return res
            .status(
                401
            )
            .json({
                success:
                    false,

                message:
                    "Admin Key ไม่ถูกต้อง"
            });
    }

    next();
}

io.on(
    "connection",
    socket => {

        console.log(
            "Client connected:",
            socket.id
        );

        socket.on(
            "disconnect",
            () => {

                console.log(
                    "Client disconnected:",
                    socket.id
                );
            }
        );
    }
);

/* =========================================================
   MULTER
========================================================= */

const upload =
    multer({

        storage:
            multer.memoryStorage(),

        limits: {
            fileSize:
                4 *
                1024 *
                1024
        },

        fileFilter(
            req,
            file,
            callback
        ) {

            const allowed = [
                "image/jpeg",
                "image/png",
                "image/webp"
            ];

            if (
                !allowed.includes(
                    file.mimetype
                )
            ) {
                return callback(
                    new Error(
                        "รองรับสลิปเฉพาะ JPG, PNG และ WEBP"
                    )
                );
            }

            callback(
                null,
                true
            );
        }
    });

const audioUpload =
    multer({

        storage:
            multer.memoryStorage(),

        limits: {
            fileSize:
                CUSTOM_SOUND_MAX_BYTES
        },

        fileFilter(
            req,
            file,
            callback
        ) {

            const allowed = [
                "audio/mpeg",
                "audio/mp3",
                "audio/wav",
                "audio/x-wav",
                "audio/ogg",
                "application/ogg"
            ];

            if (
                !allowed.includes(
                    file.mimetype
                )
            ) {
                return callback(
                    new Error(
                        "รองรับเสียงเฉพาะ MP3, WAV และ OGG"
                    )
                );
            }

            callback(
                null,
                true
            );
        }
    });

/* =========================================================
   EASYSLIP
========================================================= */

async function verifySlipWithEasySlip(
    file,
    amount
) {

    const apiKey =
        String(
            process.env.EASYSLIP_API_KEY
            ||
            ""
        )
            .trim();

    if (
        !apiKey
    ) {
        throw new Error(
            "ยังไม่ได้ตั้ง EASYSLIP_API_KEY"
        );
    }

    const form =
        new FormData();

    const blob =
        new Blob(
            [
                file.buffer
            ],
            {
                type:
                    file.mimetype
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
        String(
            amount
        )
    );

    form.append(
        "matchAccount",
        "true"
    );

    const response =
        await fetch(
            "https://api.easyslip.com/v2/verify/bank",
            {
                method:
                    "POST",

                headers: {
                    Authorization:
                        `Bearer ${apiKey}`
                },

                body:
                    form
            }
        );

    let data;

    try {

        data =
            await response.json();

    } catch {

        throw new Error(
            "EasySlip ตอบกลับผิดรูปแบบ"
        );
    }

    console.log(
        "EasySlip HTTP:",
        response.status
    );

    if (
        !response.ok
        ||
        !data.success
    ) {
        throw new Error(
            data.error?.message
            ||
            data.message
            ||
            "ตรวจสอบสลิปไม่สำเร็จ"
        );
    }

    if (
        data.data?.isDuplicate ===
        true
    ) {
        throw new Error(
            "สลิปนี้ถูกใช้ไปแล้ว ไม่สามารถใช้ซ้ำได้"
        );
    }

    if (
        !data.data?.matchedAccount
    ) {
        throw new Error(
            "บัญชีผู้รับไม่ถูกต้อง กรุณาโอนเข้าบัญชีที่กำหนด"
        );
    }

    if (
        data.data?.isAmountMatched !==
        true
    ) {
        throw new Error(
            "ยอดเงินในสลิปไม่ตรงกับยอดโดเนท"
        );
    }

    return data;
}

/* =========================================================
   VIDEO DONATION
========================================================= */

function parseYouTubeVideoUrl(
    value
) {

    let rawUrl =
        String(
            value
            ||
            ""
        )
            .trim();

    if (
        !rawUrl
    ) {
        return null;
    }

    if (
        !/^https?:\/\//i.test(
            rawUrl
        )
    ) {
        rawUrl =
            "https://"
            +
            rawUrl;
    }

    let url;

    try {

        url =
            new URL(
                rawUrl
            );

    } catch {

        throw new Error(
            "ลิงก์วิดีโอไม่ถูกต้อง"
        );
    }

    const hostname =
        url.hostname
            .toLowerCase()
            .replace(
                /^www\./,
                ""
            );

    let videoId =
        null;

    if (
        hostname ===
        "youtu.be"
    ) {
        videoId =
            url.pathname
                .split(
                    "/"
                )
                .filter(
                    Boolean
                )[0]
            ||
            null;
    }

    if (
        [
            "youtube.com",
            "m.youtube.com",
            "music.youtube.com"
        ]
            .includes(
                hostname
            )
    ) {

        if (
            url.pathname ===
            "/watch"
        ) {
            videoId =
                url.searchParams
                    .get(
                        "v"
                    );
        }

        else if (
            /^\/(shorts|embed|live)\//
                .test(
                    url.pathname
                )
        ) {
            videoId =
                url.pathname
                    .split(
                        "/"
                    )
                    .filter(
                        Boolean
                    )[1]
                ||
                null;
        }
    }

    if (
        !videoId
        ||
        !/^[A-Za-z0-9_-]{11}$/
            .test(
                videoId
            )
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

function parseVideoStart(
    value
) {

    const raw =
        String(
            value
            ??
            ""
        )
            .trim();

    if (
        !raw
    ) {
        return 0;
    }

    if (
        /^\d+$/
            .test(
                raw
            )
    ) {
        return Math.min(
            Math.max(
                0,
                Number(
                    raw
                )
            ),
            VIDEO_DONATION_MAX_START
        );
    }

    if (
        /^\d{1,2}:\d{1,2}(:\d{1,2})?$/
            .test(
                raw
            )
    ) {

        const parts =
            raw
                .split(
                    ":"
                )
                .map(
                    Number
                );

        let seconds =
            0;

        if (
            parts.length ===
            2
        ) {

            if (
                parts[1] >
                59
            ) {
                throw new Error(
                    "วินาทีต้องไม่เกิน 59"
                );
            }

            seconds =
                parts[0] *
                60
                +
                parts[1];
        }

        else {

            if (
                parts[1] >
                59
                ||
                parts[2] >
                59
            ) {
                throw new Error(
                    "นาทีหรือวินาทีไม่ถูกต้อง"
                );
            }

            seconds =
                parts[0] *
                3600
                +
                parts[1] *
                60
                +
                parts[2];
        }

        return Math.min(
            Math.max(
                0,
                seconds
            ),
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

    const rawUrl =
        String(
            body.videoUrl
            ||
            body.video_url
            ||
            ""
        )
            .trim();

    if (
        !rawUrl
    ) {
        return {
            videoUrl:
                null,

            videoId:
                null,

            videoStart:
                null,

            videoDuration:
                null
        };
    }

    if (
        Number(
            amount
        )
        <
        VIDEO_DONATION_MIN_AMOUNT
    ) {
        throw new Error(
            `แนบวิดีโอได้เมื่อสนับสนุนตั้งแต่ ${VIDEO_DONATION_MIN_AMOUNT} บาท`
        );
    }

    const video =
        parseYouTubeVideoUrl(
            rawUrl
        );

    const videoStart =
        parseVideoStart(
            body.videoStart
            ??
            body.video_start
            ??
            0
        );

    let videoDuration =
        Number.parseInt(
            body.videoDuration
            ??
            body.video_duration
            ??
            VIDEO_DONATION_MAX_DURATION,
            10
        );

    if (
        !Number.isFinite(
            videoDuration
        )
        ||
        videoDuration <=
        0
    ) {
        videoDuration =
            VIDEO_DONATION_MAX_DURATION;
    }

    videoDuration =
        Math.min(
            Math.max(
                1,
                videoDuration
            ),
            VIDEO_DONATION_MAX_DURATION
        );

    return {
        videoUrl:
            video.videoUrl,

        videoId:
            video.videoId,

        videoStart,

        videoDuration
    };
}

function validateDonationInput(
    body = {}
) {

    const amount =
        Number(
            body.amount
        );

    let name =
        String(
            body.name
            ||
            "Anonymous"
        )
            .trim()
        ||
        "Anonymous";

    const message =
        String(
            body.message
            ||
            ""
        )
            .trim();

    if (
        !Number.isFinite(
            amount
        )
        ||
        amount <
        10
    ) {
        throw new Error(
            "สนับสนุนขั้นต่ำ 10 บาท"
        );
    }

    if (
        name.length >
        30
    ) {
        throw new Error(
            "ชื่อต้องไม่เกิน 30 ตัวอักษร"
        );
    }

    if (
        message.length >
        200
    ) {
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

    const amountInSlip =
        Number(
            data.data?.amountInSlip
        );

    if (
        !Number.isFinite(
            amountInSlip
        )
    ) {
        throw new Error(
            "ไม่พบยอดเงินในสลิป"
        );
    }

    if (
        input.videoId
        &&
        amountInSlip <
        VIDEO_DONATION_MIN_AMOUNT
    ) {
        throw new Error(
            `แนบวิดีโอได้เมื่อสนับสนุนตั้งแต่ ${VIDEO_DONATION_MIN_AMOUNT} บาท`
        );
    }

    return {

        name:
            input.name,

        message:
            input.message,

        amount:
            amountInSlip,

        transRef:
            data.data?.rawSlip?.transRef
            ||
            data.data?.transRef
            ||
            null,

        videoUrl:
            input.videoUrl
            ||
            null,

        videoId:
            input.videoId
            ||
            null,

        videoStart:
            input.videoId
                ?
                Math.min(
                    Math.max(
                        0,
                        Number(
                            input.videoStart
                            ||
                            0
                        )
                    ),
                    VIDEO_DONATION_MAX_START
                )
                :
                null,

        videoDuration:
            input.videoId
                ?
                Math.min(
                    Math.max(
                        1,
                        Number(
                            input.videoDuration
                            ||
                            VIDEO_DONATION_MAX_DURATION
                        )
                    ),
                    VIDEO_DONATION_MAX_DURATION
                )
                :
                null
    };
}

/* =========================================================
   SOUND TIERS / CUSTOM SOUND
========================================================= */

function getDonationTierSound(
    amount
) {

    const value =
        Number(
            amount
        )
        ||
        0;

    if (
        value >=
        1000
    ) {
        return {
            soundTier:
                "mega",

            soundUrl:
                "/sounds/alert5.mp3"
        };
    }

    if (
        value >=
        500
    ) {
        return {
            soundTier:
                "500-999",

            soundUrl:
                "/sounds/alert5.mp3"
        };
    }

    if (
        value >=
        300
    ) {
        return {
            soundTier:
                "300-499",

            soundUrl:
                "/sounds/alert4.mp3"
        };
    }

    if (
        value >=
        100
    ) {
        return {
            soundTier:
                "100-299",

            soundUrl:
                "/sounds/alert3.mp3"
        };
    }

    if (
        value >=
        50
    ) {
        return {
            soundTier:
                "50-99",

            soundUrl:
                "/sounds/alert2.mp3"
        };
    }

    return {
        soundTier:
            "10-49",

        soundUrl:
            "/sounds/alert.mp3"
    };
}

function createCustomSoundToken() {

    return (
        "snd_"
        +
        crypto
            .randomBytes(
                24
            )
            .toString(
                "hex"
            )
    );
}

function createCustomSoundFileId() {

    return crypto
        .randomBytes(
            24
        )
        .toString(
            "hex"
        );
}

function normalizeCustomSoundToken(
    value
) {

    const token =
        String(
            value
            ||
            ""
        )
            .trim();

    return /^snd_[a-f0-9]{48}$/
        .test(
            token
        )
        ?
        token
        :
        null;
}

function getAudioExtension(
    mimeType
) {

    switch (
        mimeType
    ) {

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

async function getCustomSoundRecord(
    token
) {

    const safeToken =
        normalizeCustomSoundToken(
            token
        );

    if (
        !safeToken
    ) {
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
        [
            safeToken
        ]
    );
}

async function customSoundIsUsable(
    token,
    amount
) {

    if (
        Number(
            amount
        )
        <
        CUSTOM_SOUND_MIN_AMOUNT
    ) {
        return false;
    }

    const record =
        await getCustomSoundRecord(
            token
        );

    if (
        !record
    ) {
        return false;
    }

    if (
        Number(
            record.expires_at
        )
        <=
        Date.now()
    ) {
        return false;
    }

    if (
        ![
            "pending",
            "used"
        ]
            .includes(
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
        getDonationTierSound(
            amount
        );

    const token =
        normalizeCustomSoundToken(
            customSoundToken
        );

    if (
        !token
        ||
        Number(
            amount
        )
        <
        CUSTOM_SOUND_MIN_AMOUNT
    ) {
        return {
            ...tier,

            customSound:
                false,

            soundToken:
                null
        };
    }

    if (
        !(
            await customSoundIsUsable(
                token,
                amount
            )
        )
    ) {

        console.warn(
            "Custom Sound ใช้ไม่ได้/หมดอายุ -> fallback tier sound"
        );

        return {
            ...tier,

            customSound:
                false,

            soundToken:
                null
        };
    }

    return {

        soundTier:
            "custom",

        soundUrl:
            `/api/custom-sound/${encodeURIComponent(token)}/audio`,

        customSound:
            true,

        soundToken:
            token
    };
}

async function markCustomSoundUsed(
    token
) {

    const safeToken =
        normalizeCustomSoundToken(
            token
        );

    if (
        !safeToken
    ) {
        return;
    }

    const now =
        Date.now();

    const keepUntil =
        now
        +
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

    if (
        !file
    ) {
        throw new Error(
            "กรุณาเลือกไฟล์เสียง"
        );
    }

    const expectedAmount =
        Number(
            amount
        );

    if (
        !Number.isFinite(
            expectedAmount
        )
        ||
        expectedAmount <
        CUSTOM_SOUND_MIN_AMOUNT
    ) {
        throw new Error(
            `Custom Sound ใช้ได้เมื่อโดเนท ${CUSTOM_SOUND_MIN_AMOUNT} บาทขึ้นไป`
        );
    }

    const extension =
        getAudioExtension(
            file.mimetype
        );

    if (
        !extension
    ) {
        throw new Error(
            "รองรับเสียงเฉพาะ MP3, WAV และ OGG"
        );
    }

    const token =
        createCustomSoundToken();

    const fileName =
        createCustomSoundFileId()
        +
        extension;

    const filePath =
        path.join(
            CUSTOM_SOUND_DIR,
            fileName
        );

    const createdAt =
        Date.now();

    const expiresAt =
        createdAt
        +
        CUSTOM_SOUND_TTL_MS;

    await fs.promises.writeFile(
        filePath,
        file.buffer,
        {
            flag:
                "wx"
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
                    file.originalname
                    ||
                    "sound"
                )
                    .slice(
                        0,
                        160
                    ),
                file.mimetype,
                Number(
                    file.size
                    ||
                    file.buffer.length
                    ||
                    0
                ),
                createdAt,
                expiresAt
            ]
        );

    } catch (
        error
    ) {

        await fs.promises.unlink(
            filePath
        )
            .catch(
                () => {}
            );

        throw error;
    }

    return {
        token,

        expiresAt,

        maxPlaybackSeconds:
            10
    };
}

async function cleanupCustomSounds() {

    try {

        const now =
            Date.now();

        const expired =
            await dbAll(
                `
                SELECT
                    token,
                    file_name

                FROM custom_sounds

                WHERE expires_at <= ?
                `,
                [
                    now
                ]
            );

        for (
            const item
            of expired
        ) {

            await fs.promises.unlink(
                path.join(
                    CUSTOM_SOUND_DIR,
                    item.file_name
                )
            )
                .catch(
                    () => {}
                );
        }

        if (
            expired.length
        ) {

            await dbRun(
                `
                DELETE FROM custom_sounds
                WHERE expires_at <= ?
                `,
                [
                    now
                ]
            );

            console.log(
                `🧹 Custom Sounds cleaned: ${expired.length}`
            );
        }

    } catch (
        error
    ) {

        console.error(
            "Custom Sound Cleanup:",
            error
        );
    }
}

/* =========================================================
   SAVE / BROADCAST DONATION
========================================================= */

async function saveDonation(
    donation
) {

    if (
        !donation.transRef
    ) {
        throw new Error(
            "ไม่พบเลขอ้างอิงธุรกรรมในสลิป"
        );
    }

    try {

        const result =
            await dbRun(
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
                    donation.videoUrl
                    ||
                    null,
                    donation.videoId
                    ||
                    null,
                    donation.videoId
                        ?
                        Number(
                            donation.videoStart
                            ||
                            0
                        )
                        :
                        null,
                    donation.videoId
                        ?
                        Math.min(
                            Number(
                                donation.videoDuration
                                ||
                                VIDEO_DONATION_MAX_DURATION
                            ),
                            VIDEO_DONATION_MAX_DURATION
                        )
                        :
                        null
                ]
            );

        console.log(
            "Donation saved ID:",
            result.lastID
        );

        return result;

    } catch (
        error
    ) {

        if (
            error?.code ===
            "23505"
            ||
            String(
                error.message
            )
                .includes(
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

async function broadcastDonation(
    donation
) {

    io.emit(
        "donation",
        donation
    );

    io.emit(
        "ranking-update",
        await getTopDonorsFromDB()
    );

    await emitGoalUpdate();
}

/* =========================================================
   MOBILE SESSIONS
========================================================= */

function generateMobileSessionId() {

    return (
        "mob_"
        +
        crypto
            .randomBytes(
                24
            )
            .toString(
                "hex"
            )
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
            session.customSoundToken
            ||
            null,
            session.videoUrl
            ||
            null,
            session.videoId
            ||
            null,
            session.videoId
                ?
                Number(
                    session.videoStart
                    ||
                    0
                )
                :
                null,
            session.videoId
                ?
                Math.min(
                    Number(
                        session.videoDuration
                        ||
                        VIDEO_DONATION_MAX_DURATION
                    ),
                    VIDEO_DONATION_MAX_DURATION
                )
                :
                null
        ]
    );

    return session;
}

async function getMobileSessionDB(
    sessionId
) {

    const row =
        await dbGet(
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
            [
                sessionId
            ]
        );

    if (
        !row
    ) {
        return null;
    }

    return {

        sessionId:
            row.session_id,

        name:
            row.name,

        message:
            row.message
            ||
            "",

        amount:
            Number(
                row.amount
            ),

        status:
            row.status,

        createdAt:
            Number(
                row.created_at
            ),

        expiresAt:
            Number(
                row.expires_at
            ),

        verifiedAt:
            row.verified_at
                ?
                Number(
                    row.verified_at
                )
                :
                null,

        transRef:
            row.trans_ref
            ||
            null,

        customSoundToken:
            row.custom_sound_token
            ||
            null,

        videoUrl:
            row.video_url
            ||
            null,

        videoId:
            row.video_id
            ||
            null,

        videoStart:
            row.video_id
                ?
                Number(
                    row.video_start
                    ||
                    0
                )
                :
                null,

        videoDuration:
            row.video_id
                ?
                Math.min(
                    Number(
                        row.video_duration
                        ||
                        VIDEO_DONATION_MAX_DURATION
                    ),
                    VIDEO_DONATION_MAX_DURATION
                )
                :
                null
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
        [
            sessionId
        ]
    );
}

async function lockMobileSession(
    sessionId
) {

    const result =
        await dbRun(
            `
            UPDATE mobile_sessions

            SET
                status = 'verifying'

            WHERE
                session_id = ?
                AND
                status = 'pending'
                AND
                expires_at > ?
            `,
            [
                sessionId,
                Date.now()
            ]
        );

    return result.changes ===
        1;
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
            AND
            status = 'verifying'
            AND
            expires_at > ?
        `,
        [
            sessionId,
            Date.now()
        ]
    );
}

async function saveMobileDonationAndComplete(
    sessionId,
    donation
) {

    const client =
        await pool.connect();

    try {

        await client.query(
            "BEGIN"
        );

        const insertResult =
            await dbRun(
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
                    donation.videoUrl
                    ||
                    null,
                    donation.videoId
                    ||
                    null,
                    donation.videoId
                        ?
                        Number(
                            donation.videoStart
                            ||
                            0
                        )
                        :
                        null,
                    donation.videoId
                        ?
                        Math.min(
                            Number(
                                donation.videoDuration
                                ||
                                VIDEO_DONATION_MAX_DURATION
                            ),
                            VIDEO_DONATION_MAX_DURATION
                        )
                        :
                        null
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
                    AND
                    status = 'verifying'
                `,
                [
                    Date.now(),
                    donation.transRef,
                    sessionId
                ],
                client
            );

        if (
            updateResult.changes !==
            1
        ) {
            throw new Error(
                "ไม่สามารถยืนยัน Mobile Session ได้"
            );
        }

        await client.query(
            "COMMIT"
        );

        return insertResult;

    } catch (
        error
    ) {

        await client.query(
            "ROLLBACK"
        )
            .catch(
                () => {}
            );

        if (
            error?.code ===
            "23505"
            ||
            String(
                error.message
            )
                .includes(
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

        const result =
            await dbRun(
                `
                DELETE FROM mobile_sessions
                WHERE expires_at <= ?
                `,
                [
                    Date.now()
                ]
            );

        if (
            result.changes >
            0
        ) {
            console.log(
                `🧹 Mobile Sessions cleaned: ${result.changes}`
            );
        }

    } catch (
        error
    ) {

        console.error(
            "Mobile Session Cleanup:",
            error
        );
    }
}

async function recoverMobileSessions() {

    try {

        const result =
            await dbRun(
                `
                UPDATE mobile_sessions

                SET
                    status = 'pending'

                WHERE
                    status = 'verifying'
                    AND
                    expires_at > ?
                `,
                [
                    Date.now()
                ]
            );

        if (
            result.changes >
            0
        ) {
            console.log(
                `♻ Mobile Sessions recovered: ${result.changes}`
            );
        }

    } catch (
        error
    ) {

        console.error(
            "Mobile Session Recovery:",
            error
        );
    }
}

function getPublicBaseUrl(
    req
) {

    if (
        PUBLIC_BASE_URL
    ) {
        return PUBLIC_BASE_URL;
    }

    const forwardedProto =
        String(
            req.headers[
                "x-forwarded-proto"
            ]
            ||
            ""
        )
            .split(
                ","
            )[0]
            .trim();

    const protocol =
        forwardedProto
        ||
        req.protocol
        ||
        "http";

    return (
        `${protocol}://${req.get("host")}`
    );
}

/* =========================================================
   ROUTES: CUSTOM SOUND
========================================================= */

app.post(
    "/api/custom-sound/upload",
    audioUpload.single(
        "sound"
    ),
    async (
        req,
        res
    ) => {

        try {

            const result =
                await saveUploadedCustomSound(
                    req.file,
                    Number(
                        req.body.amount
                    )
                );

            res.json({
                success:
                    true,

                message:
                    "อัปโหลด Custom Sound แล้ว",

                customSound:
                    result
            });

        } catch (
            error
        ) {

            console.error(
                "Custom Sound Upload Error:",
                error
            );

            res
                .status(
                    400
                )
                .json({
                    success:
                        false,

                    message:
                        error.message
                        ||
                        "อัปโหลดเสียงไม่สำเร็จ"
                });
        }
    }
);

app.get(
    "/api/custom-sound/:token/audio",
    async (
        req,
        res
    ) => {

        try {

            const token =
                normalizeCustomSoundToken(
                    req.params.token
                );

            if (
                !token
            ) {
                return res
                    .status(
                        404
                    )
                    .end();
            }

            const record =
                await getCustomSoundRecord(
                    token
                );

            if (
                !record
                ||
                Number(
                    record.expires_at
                )
                <=
                Date.now()
            ) {
                return res
                    .status(
                        404
                    )
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

            res.type(
                record.mime_type
            );

            res.sendFile(
                filePath
            );

        } catch (
            error
        ) {

            console.error(
                "Custom Sound Stream Error:",
                error
            );

            res
                .status(
                    404
                )
                .end();
        }
    }
);

/* =========================================================
   ROUTES: PROMPTPAY / VERIFY
========================================================= */

app.get(
    "/generate-qr/:amount",
    async (
        req,
        res
    ) => {

        try {

            const amount =
                Number(
                    req.params.amount
                );

            if (
                !Number.isFinite(
                    amount
                )
                ||
                amount <
                10
            ) {
                return res
                    .status(
                        400
                    )
                    .json({
                        success:
                            false,

                        message:
                            "ยอดสนับสนุนขั้นต่ำ 10 บาท"
                    });
            }

            const promptpayID =
                String(
                    process.env.PROMPTPAY_ID
                    ||
                    ""
                )
                    .trim();

            if (
                !promptpayID
            ) {
                return res
                    .status(
                        500
                    )
                    .json({
                        success:
                            false,

                        message:
                            "ยังไม่ได้ตั้ง PROMPTPAY_ID"
                    });
            }

            const payload =
                generatePayload(
                    promptpayID,
                    {
                        amount
                    }
                );

            const qr =
                await QRCode.toDataURL(
                    payload
                );

            res.json({
                success:
                    true,

                qr,

                amount
            });

        } catch (
            error
        ) {

            console.error(
                "QR ERROR:",
                error
            );

            res
                .status(
                    500
                )
                .json({
                    success:
                        false,

                    message:
                        "สร้าง QR ไม่สำเร็จ"
                });
        }
    }
);

app.post(
    "/verify-slip",
    upload.single(
        "slip"
    ),
    async (
        req,
        res
    ) => {

        try {

            if (
                !req.file
            ) {
                return res
                    .status(
                        400
                    )
                    .json({
                        success:
                            false,

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
                    req.body.customSoundToken
                )
            );

            await saveDonation(
                donation
            );

            if (
                donation.customSound
                &&
                donation.soundToken
            ) {
                await markCustomSoundUsed(
                    donation.soundToken
                )
                    .catch(
                        error =>
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
                success:
                    true,

                message:
                    "ตรวจสอบสลิปสำเร็จ",

                donation,

                data:
                    data.data
            });

        } catch (
            error
        ) {

            console.error(
                "VERIFY ERROR:",
                error
            );

            res
                .status(
                    400
                )
                .json({
                    success:
                        false,

                    message:
                        error.message
                        ||
                        "ตรวจสอบสลิปไม่สำเร็จ"
                });
        }
    }
);

/* =========================================================
   ROUTES: TOP DONORS / GOAL
========================================================= */

app.get(
    "/top-donors",
    async (
        req,
        res
    ) => {

        try {

            res.json({
                success:
                    true,

                donors:
                    await getTopDonorsFromDB()
            });

        } catch (
            error
        ) {

            console.error(
                "Top Donors Error:",
                error
            );

            res
                .status(
                    500
                )
                .json({
                    success:
                        false,

                    donors:
                        [],

                    message:
                        "โหลดอันดับไม่สำเร็จ"
                });
        }
    }
);

app.get(
    "/api/goal",
    async (
        req,
        res
    ) => {

        try {

            res.json({
                success:
                    true,

                ...(
                    await getDonationGoal()
                )
            });

        } catch (
            error
        ) {

            console.error(
                "Public Goal Error:",
                error
            );

            res
                .status(
                    500
                )
                .json({
                    success:
                        false,

                    message:
                        "โหลด Goal ไม่สำเร็จ"
                });
        }
    }
);

app.get(
    "/api/admin/goal",
    requireAdminKey,
    async (
        req,
        res
    ) => {

        try {

            res.json({
                success:
                    true,

                goal:
                    await getDonationGoal()
            });

        } catch (
            error
        ) {

            console.error(
                "Admin Get Goal:",
                error
            );

            res
                .status(
                    500
                )
                .json({
                    success:
                        false,

                    message:
                        "โหลด Goal ไม่สำเร็จ"
                });
        }
    }
);

app.post(
    "/api/admin/goal",
    requireAdminKey,
    async (
        req,
        res
    ) => {

        try {

            const title =
                String(
                    req.body.title
                    ||
                    "เป้าหมายสนับสนุน"
                )
                    .trim();

            const target =
                Number(
                    req.body.target
                );

            const enabled =
                toBoolean(
                    req.body.enabled
                );

            if (
                !Number.isFinite(
                    target
                )
                ||
                target <=
                0
            ) {
                return res
                    .status(
                        400
                    )
                    .json({
                        success:
                            false,

                        message:
                            "เป้าหมายต้องมากกว่า 0 บาท"
                    });
            }

            if (
                title.length >
                60
            ) {
                return res
                    .status(
                        400
                    )
                    .json({
                        success:
                            false,

                        message:
                            "ชื่อ Goal ต้องไม่เกิน 60 ตัวอักษร"
                    });
            }

            await Promise.all([
                setSetting(
                    "goal_title",
                    title
                    ||
                    "เป้าหมายสนับสนุน"
                ),
                setSetting(
                    "goal_target",
                    target
                ),
                setSetting(
                    "goal_enabled",
                    enabled
                        ?
                        "1"
                        :
                        "0"
                )
            ]);

            const goal =
                await getDonationGoal();

            io.emit(
                "goal-update",
                goal
            );

            res.json({
                success:
                    true,

                goal
            });

        } catch (
            error
        ) {

            console.error(
                "Update Goal Error:",
                error
            );

            res
                .status(
                    500
                )
                .json({
                    success:
                        false,

                    message:
                        "บันทึก Goal ไม่สำเร็จ"
                });
        }
    }
);

app.post(
    "/api/admin/goal/reset",
    requireAdminKey,
    async (
        req,
        res
    ) => {

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
                success:
                    true,

                goal
            });

        } catch (
            error
        ) {

            console.error(
                "Reset Goal Error:",
                error
            );

            res
                .status(
                    500
                )
                .json({
                    success:
                        false,

                    message:
                        "รีเซ็ต Goal ไม่สำเร็จ"
                });
        }
    }
);

/* =========================================================
   ROUTES: ALERT SETTINGS / AUDIO CONTROL
========================================================= */

app.get(
    "/api/alert-settings",
    async (
        req,
        res
    ) => {

        try {

            res.json({
                success:
                    true,

                settings:
                    await getAlertSettings()
            });

        } catch (
            error
        ) {

            console.error(
                "Get Alert Settings Error:",
                error
            );

            res
                .status(
                    500
                )
                .json({
                    success:
                        false,

                    message:
                        "โหลด Alert Settings ไม่สำเร็จ"
                });
        }
    }
);

app.get(
    "/api/admin/alert-settings",
    requireAdminKey,
    async (
        req,
        res
    ) => {

        try {

            res.json({
                success:
                    true,

                settings:
                    await getAlertSettings()
            });

        } catch (
            error
        ) {

            console.error(
                "Admin Get Alert Settings Error:",
                error
            );

            res
                .status(
                    500
                )
                .json({
                    success:
                        false,

                    message:
                        "โหลด Alert Settings ไม่สำเร็จ"
                });
        }
    }
);

app.post(
    "/api/admin/alert-settings",
    requireAdminKey,
    async (
        req,
        res
    ) => {

        try {

            const current =
                await getAlertSettings();

            const pickBool =
                (
                    key,
                    fallback
                ) =>
                    req.body[key] ===
                    undefined
                        ?
                        fallback
                        :
                        toBoolean(
                            req.body[key]
                        );

            const pickNum =
                (
                    key,
                    fallback
                ) =>
                    req.body[key] ===
                    undefined
                        ?
                        fallback
                        :
                        Number(
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
                    current.noTtsDisplayTime
                );

            const alertVolume =
                normalizeVolumeValue(
                    req.body.alertVolume,
                    current.alertVolume
                );

            const customSoundVolume =
                normalizeVolumeValue(
                    req.body.customSoundVolume,
                    current.customSoundVolume
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
                    current.customSoundMuted
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
                    ?
                    String(
                        current.ttsVoiceURI
                        ||
                        "auto"
                    )
                    :
                    (
                        String(
                            req.body.ttsVoiceURI
                            ||
                            "auto"
                        )
                            .trim()
                            .slice(
                                0,
                                255
                            )
                        ||
                        "auto"
                    );

            const ttsVoiceName =
                req.body.ttsVoiceName ===
                undefined
                    ?
                    String(
                        current.ttsVoiceName
                        ||
                        ""
                    )
                    :
                    String(
                        req.body.ttsVoiceName
                        ||
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
                    ?
                    String(
                        current.ttsLang
                        ||
                        "th-TH"
                    )
                    :
                    (
                        String(
                            req.body.ttsLang
                            ||
                            "th-TH"
                        )
                            .trim()
                            .slice(
                                0,
                                40
                            )
                        ||
                        "th-TH"
                    );

            if (
                !Number.isFinite(
                    ttsRate
                )
                ||
                ttsRate <
                0.5
                ||
                ttsRate >
                2
            ) {
                return res
                    .status(
                        400
                    )
                    .json({
                        success:
                            false,

                        message:
                            "ความเร็ว TTS ต้องอยู่ระหว่าง 0.5 - 2.0"
                    });
            }

            if (
                !Number.isFinite(
                    ttsPitch
                )
                ||
                ttsPitch <
                0.5
                ||
                ttsPitch >
                2
            ) {
                return res
                    .status(
                        400
                    )
                    .json({
                        success:
                            false,

                        message:
                            "Pitch TTS ต้องอยู่ระหว่าง 0.5 - 2.0"
                    });
            }

            if (
                !Number.isFinite(
                    bigAmount
                )
                ||
                bigAmount <=
                0
            ) {
                return res
                    .status(
                        400
                    )
                    .json({
                        success:
                            false,

                        message:
                            "ยอด BIG Donation ต้องมากกว่า 0 บาท"
                    });
            }

            if (
                !Number.isFinite(
                    megaAmount
                )
                ||
                megaAmount <=
                bigAmount
            ) {
                return res
                    .status(
                        400
                    )
                    .json({
                        success:
                            false,

                        message:
                            "ยอด MEGA Donation ต้องมากกว่า BIG Donation"
                    });
            }

            if (
                !Number.isFinite(
                    afterTtsDelay
                )
                ||
                afterTtsDelay <
                0
                ||
                afterTtsDelay >
                10000
            ) {
                return res
                    .status(
                        400
                    )
                    .json({
                        success:
                            false,

                        message:
                            "เวลาค้างหลัง TTS ต้องอยู่ระหว่าง 0 - 10 วินาที"
                    });
            }

            if (
                !Number.isFinite(
                    noTtsDisplayTime
                )
                ||
                noTtsDisplayTime <
                1000
                ||
                noTtsDisplayTime >
                30000
            ) {
                return res
                    .status(
                        400
                    )
                    .json({
                        success:
                            false,

                        message:
                            "เวลาแสดง Alert ต้องอยู่ระหว่าง 1 - 30 วินาที"
                    });
            }

            await Promise.all([

                setSetting(
                    "alert_tts_enabled",
                    ttsEnabled
                        ?
                        "1"
                        :
                        "0"
                ),

                setSetting(
                    "alert_read_message",
                    readMessage
                        ?
                        "1"
                        :
                        "0"
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
                        ?
                        "1"
                        :
                        "0"
                ),

                setSetting(
                    "alert_custom_sound_muted",
                    customSoundMuted
                        ?
                        "1"
                        :
                        "0"
                ),

                setSetting(
                    "alert_tts_muted",
                    ttsMuted
                        ?
                        "1"
                        :
                        "0"
                ),

                setSetting(
                    "alert_video_muted",
                    videoMuted
                        ?
                        "1"
                        :
                        "0"
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
                success:
                    true,

                message:
                    "บันทึก Alert Settings แล้ว",

                settings
            });

        } catch (
            error
        ) {

            console.error(
                "Update Alert Settings Error:",
                error
            );

            res
                .status(
                    400
                )
                .json({
                    success:
                        false,

                    message:
                        error.message
                        ||
                        "บันทึก Alert Settings ไม่สำเร็จ"
                });
        }
    }
);

/* =========================================================
   ROUTES: MOBILE UPLOAD
========================================================= */

app.post(
    "/api/mobile-upload/create",
    async (
        req,
        res
    ) => {

        try {

            const input =
                validateDonationInput(
                    req.body
                );

            const requestedToken =
                normalizeCustomSoundToken(
                    req.body.customSoundToken
                );

            let customSoundToken =
                null;

            if (
                requestedToken
                &&
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
                createdAt
                +
                MOBILE_SESSION_TTL_MS;

            const session = {

                sessionId,

                name:
                    input.name,

                message:
                    input.message,

                amount:
                    input.amount,

                status:
                    "pending",

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
                `${getPublicBaseUrl(req)}/mobile-upload.html?session=${encodeURIComponent(sessionId)}`;

            const qr =
                await QRCode.toDataURL(
                    uploadUrl
                );

            console.log(
                "📱 Mobile Session created:",
                sessionId
            );

            res.json({

                success:
                    true,

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

        } catch (
            error
        ) {

            console.error(
                "Create Mobile Session:",
                error
            );

            res
                .status(
                    400
                )
                .json({
                    success:
                        false,

                    message:
                        error.message
                        ||
                        "สร้าง Mobile Upload ไม่สำเร็จ"
                });
        }
    }
);

app.get(
    "/api/mobile-upload/session/:sessionId",
    async (
        req,
        res
    ) => {

        try {

            const sessionId =
                String(
                    req.params.sessionId
                    ||
                    ""
                )
                    .trim();

            const session =
                await getMobileSessionDB(
                    sessionId
                );

            if (
                !session
            ) {
                return res
                    .status(
                        404
                    )
                    .json({
                        success:
                            false,

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
                    .status(
                        410
                    )
                    .json({
                        success:
                            false,

                        message:
                            "Session หมดอายุแล้ว"
                    });
            }

            res.json({

                success:
                    true,

                session: {

                    sessionId:
                        session.sessionId,

                    name:
                        session.name,

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

        } catch (
            error
        ) {

            console.error(
                "Get Mobile Session:",
                error
            );

            res
                .status(
                    500
                )
                .json({
                    success:
                        false,

                    message:
                        "โหลด Mobile Session ไม่สำเร็จ"
                });
        }
    }
);

app.post(
    "/api/mobile-upload/verify/:sessionId",
    upload.single(
        "slip"
    ),
    async (
        req,
        res
    ) => {

        let sessionId =
            null;

        let locked =
            false;

        try {

            sessionId =
                String(
                    req.params.sessionId
                    ||
                    ""
                )
                    .trim();

            const session =
                await getMobileSessionDB(
                    sessionId
                );

            if (
                !session
            ) {
                return res
                    .status(
                        404
                    )
                    .json({
                        success:
                            false,

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
                    .status(
                        410
                    )
                    .json({
                        success:
                            false,

                        message:
                            "Session หมดอายุแล้ว กรุณาสร้าง QR ใหม่"
                    });
            }

            if (
                session.status ===
                "verified"
            ) {
                return res
                    .status(
                        409
                    )
                    .json({
                        success:
                            false,

                        message:
                            "Session นี้ถูกใช้งานสำเร็จไปแล้ว"
                    });
            }

            if (
                session.status ===
                "verifying"
            ) {
                return res
                    .status(
                        409
                    )
                    .json({
                        success:
                            false,

                        message:
                            "กำลังตรวจสอบสลิปนี้อยู่ กรุณารอสักครู่"
                    });
            }

            if (
                !req.file
            ) {
                return res
                    .status(
                        400
                    )
                    .json({
                        success:
                            false,

                        message:
                            "กรุณาเลือกสลิป"
                    });
            }

            locked =
                await lockMobileSession(
                    sessionId
                );

            if (
                !locked
            ) {
                return res
                    .status(
                        409
                    )
                    .json({
                        success:
                            false,

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
                    session.customSoundToken
                )
            );

            await saveMobileDonationAndComplete(
                sessionId,
                donation
            );

            locked =
                false;

            if (
                donation.customSound
                &&
                donation.soundToken
            ) {
                await markCustomSoundUsed(
                    donation.soundToken
                )
                    .catch(
                        error =>
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
                success:
                    true,

                message:
                    "ส่งสลิปจากมือถือสำเร็จ",

                donation
            });

        } catch (
            error
        ) {

            console.error(
                "Mobile Verify Error:",
                error
            );

            if (
                locked
                &&
                sessionId
            ) {
                await resetMobileSession(
                    sessionId
                )
                    .catch(
                        resetError =>
                            console.error(
                                "Reset Mobile Session Error:",
                                resetError
                            )
                    );
            }

            res
                .status(
                    400
                )
                .json({
                    success:
                        false,

                    message:
                        error.message
                        ||
                        "ตรวจสอบสลิปไม่สำเร็จ"
                });
        }
    }
);

/* =========================================================
   TEST / REPLAY
========================================================= */

app.post(
    "/test-donation",
    requireAdminKey,
    (
        req,
        res
    ) => {

        try {

            const name =
                String(
                    req.body?.name
                    ||
                    "AMR29 Test"
                )
                    .trim()
                    .slice(
                        0,
                        30
                    )
                ||
                "AMR29 Test";

            const message =
                String(
                    req.body?.message
                    ||
                    ""
                )
                    .trim()
                    .slice(
                        0,
                        200
                    );

            const amount =
                Number(
                    req.body?.amount
                );

            if (
                !Number.isFinite(
                    amount
                )
                ||
                amount <
                10
            ) {
                return res
                    .status(
                        400
                    )
                    .json({
                        success:
                            false,

                        message:
                            "จำนวนเงิน Test ต้องตั้งแต่ 10 บาทขึ้นไป"
                    });
            }

            let video = {
                videoUrl:
                    null,

                videoId:
                    null,

                videoStart:
                    null,

                videoDuration:
                    null
            };

            if (
                String(
                    req.body?.videoUrl
                    ||
                    ""
                )
                    .trim()
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

                customSound:
                    false,

                soundToken:
                    null,

                ...video,

                isTest:
                    true,

                test:
                    true,

                createdAt:
                    Date.now()
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
                success:
                    true,

                message:
                    "ส่ง Test Donation แล้ว",

                donation
            });

        } catch (
            error
        ) {

            console.error(
                "Test Donation Error:",
                error
            );

            res
                .status(
                    400
                )
                .json({
                    success:
                        false,

                    message:
                        error.message
                        ||
                        "Test Donation ไม่สำเร็จ"
                });
        }
    }
);

app.post(
    "/api/admin/donation/:id/replay",
    requireAdminKey,
    async (
        req,
        res
    ) => {

        try {

            const donationId =
                Number(
                    req.params.id
                );

            if (
                !Number.isInteger(
                    donationId
                )
                ||
                donationId <=
                0
            ) {
                return res
                    .status(
                        400
                    )
                    .json({
                        success:
                            false,

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
                    [
                        donationId
                    ]
                );

            if (
                !donation
            ) {
                return res
                    .status(
                        404
                    )
                    .json({
                        success:
                            false,

                        message:
                            "ไม่พบ Donation นี้"
                    });
            }

            const replayDonation = {

                id:
                    donation.id,

                name:
                    donation.name,

                message:
                    donation.message
                    ||
                    "",

                amount:
                    Number(
                        donation.amount
                        ||
                        0
                    ),

                ...getDonationTierSound(
                    donation.amount
                ),

                customSound:
                    false,

                soundToken:
                    null,

                isReplay:
                    true,

                replay:
                    true,

                originalDonationId:
                    donation.id,

                videoUrl:
                    donation.video_url
                    ||
                    null,

                videoId:
                    donation.video_id
                    ||
                    null,

                videoStart:
                    donation.video_id
                        ?
                        Number(
                            donation.video_start
                            ||
                            0
                        )
                        :
                        null,

                videoDuration:
                    donation.video_id
                        ?
                        Math.min(
                            Number(
                                donation.video_duration
                                ||
                                VIDEO_DONATION_MAX_DURATION
                            ),
                            VIDEO_DONATION_MAX_DURATION
                        )
                        :
                        null,

                createdAt:
                    Date.now()
            };

            io.emit(
                "donation",
                replayDonation
            );

            res.json({
                success:
                    true,

                message:
                    "เล่น Alert ซ้ำแล้ว",

                donation:
                    replayDonation
            });

        } catch (
            error
        ) {

            console.error(
                "Replay Donation Error:",
                error
            );

            res
                .status(
                    500
                )
                .json({
                    success:
                        false,

                    message:
                        error.message
                        ||
                        "Replay Alert ไม่สำเร็จ"
                });
        }
    }
);

/* =========================================================
   DASHBOARD
========================================================= */

app.get(
    "/api/dashboard",
    requireAdminKey,
    async (
        req,
        res
    ) => {

        try {

            const [
                today,
                month,
                all,
                recent,
                topDonors,
                goal,
                alertSettings
            ] =
                await Promise.all([

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
                recent.map(
                    row => ({
                        ...row,

                        amount:
                            Number(
                                row.amount
                                ||
                                0
                            ),

                        videoUrl:
                            row.video_url
                            ||
                            null,

                        videoId:
                            row.video_id
                            ||
                            null,

                        videoStart:
                            row.video_id
                                ?
                                Number(
                                    row.video_start
                                    ||
                                    0
                                )
                                :
                                null,

                        videoDuration:
                            row.video_id
                                ?
                                Math.min(
                                    Number(
                                        row.video_duration
                                        ||
                                        VIDEO_DONATION_MAX_DURATION
                                    ),
                                    VIDEO_DONATION_MAX_DURATION
                                )
                                :
                                null
                    })
                );

            res.json({

                success:
                    true,

                stats: {

                    today: {
                        count:
                            Number(
                                today?.count
                                ||
                                0
                            ),

                        total:
                            Number(
                                today?.total
                                ||
                                0
                            )
                    },

                    month: {
                        count:
                            Number(
                                month?.count
                                ||
                                0
                            ),

                        total:
                            Number(
                                month?.total
                                ||
                                0
                            )
                    },

                    all: {
                        count:
                            Number(
                                all?.count
                                ||
                                0
                            ),

                        total:
                            Number(
                                all?.total
                                ||
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

        } catch (
            error
        ) {

            console.error(
                "Dashboard error:",
                error
            );

            res
                .status(
                    500
                )
                .json({
                    success:
                        false,

                    message:
                        `โหลด Dashboard ไม่สำเร็จ: ${error.message}`
                });
        }
    }
);

/* =========================================================
   UPLOAD ERROR
========================================================= */

app.use(
    (
        error,
        req,
        res,
        next
    ) => {

        if (
            error instanceof
            multer.MulterError
            &&
            error.code ===
            "LIMIT_FILE_SIZE"
        ) {

            const customSound =
                req.path.includes(
                    "custom-sound"
                );

            return res
                .status(
                    400
                )
                .json({
                    success:
                        false,

                    message:
                        customSound
                            ?
                            "ไฟล์เสียงต้องไม่เกิน 3 MB"
                            :
                            "ไฟล์สลิปต้องไม่เกิน 4 MB"
                });
        }

        if (
            error
        ) {

            console.error(
                "Upload Error:",
                error
            );

            return res
                .status(
                    400
                )
                .json({
                    success:
                        false,

                    message:
                        error.message
                        ||
                        "อัปโหลดไฟล์ไม่สำเร็จ"
                });
        }

        next();
    }
);

/* =========================================================
   START / SHUTDOWN
========================================================= */

let cleanupInterval =
    null;

let isShuttingDown =
    false;

async function closeDatabase() {

    try {

        await pool.end();

    } catch (
        error
    ) {

        console.error(
            "PostgreSQL close error:",
            error
        );
    }
}

async function gracefulShutdown(
    signal
) {

    if (
        isShuttingDown
    ) {
        return;
    }

    isShuttingDown =
        true;

    console.log(
        `\n${signal} received - shutting down...`
    );

    if (
        cleanupInterval
    ) {
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

                process.exit(
                    1
                );
            },
            10000
        );

    forceTimer.unref();

    server.close(
        async error => {

            if (
                error
            ) {
                console.error(
                    "HTTP server close error:",
                    error
                );
            }

            await closeDatabase();

            process.exit(
                error
                    ?
                    1
                    :
                    0
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
                        .catch(
                            error =>
                                console.error(
                                    "Mobile cleanup interval:",
                                    error
                                )
                        );

                    cleanupCustomSounds()
                        .catch(
                            error =>
                                console.error(
                                    "Custom sound cleanup interval:",
                                    error
                                )
                        );
                },
                60 *
                1000
            );

        cleanupInterval
            .unref
            ?.();

        server.listen(
            PORT,
            "0.0.0.0",
            () => {

                const baseUrl =
                    PUBLIC_BASE_URL
                    ||
                    `http://localhost:${PORT}`;

                console.log(
                    "\n======================================="
                );

                console.log(
                    "        AMR29 DONATE SERVER"
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

                console.log(
                    ""
                );

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

                console.log(
                    ""
                );

                console.log(
                    "ADMIN_KEY:",
                    process.env.ADMIN_KEY
                        ?
                        "Loaded ✓"
                        :
                        "NOT SET ✗"
                );

                console.log(
                    "PROMPTPAY_ID:",
                    process.env.PROMPTPAY_ID
                        ?
                        "Loaded ✓"
                        :
                        "NOT SET ✗"
                );

                console.log(
                    "EASYSLIP:",
                    process.env.EASYSLIP_API_KEY
                        ?
                        "Loaded ✓"
                        :
                        "NOT SET ✗"
                );

                console.log(
                    "PUBLIC_BASE_URL:",
                    PUBLIC_BASE_URL
                    ||
                    "Not set"
                );

                console.log(
                    "DATABASE_URL:",
                    DATABASE_URL
                        ?
                        "Loaded ✓"
                        :
                        "NOT SET ✗"
                );

                console.log(
                    "======================================="
                );
            }
        );

    } catch (
        error
    ) {

        console.error(
            "Server startup failed:",
            error
        );

        process.exit(
            1
        );
    }
}

start();