const sqlite3 = require("sqlite3").verbose();
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
   ENVIRONMENT / CONFIG
========================================================= */

const ALLOWED_ENVIRONMENTS = [
    "development",
    "staging",
    "production"
];


const APP_ENV =
    String(
        process.env.APP_ENV ||
        process.env.NODE_ENV ||
        "development"
    )
        .trim()
        .toLowerCase();


const IS_DEVELOPMENT =
    APP_ENV === "development";


const IS_STAGING =
    APP_ENV === "staging";


const IS_PRODUCTION =
    APP_ENV === "production";


const IS_DEPLOYED =
    IS_STAGING ||
    IS_PRODUCTION;


/* =========================================================
   PORT / VERSION / PUBLIC URL
========================================================= */

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


/* =========================================================
   MOBILE SESSION
========================================================= */

const MOBILE_SESSION_TTL_MS =
    15 * 60 * 1000;


/* =========================================================
   DATA / STATIC PATHS
========================================================= */

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


const DB_PATH =
    path.join(
        DATA_DIR,
        "donations.db"
    );


const PUBLIC_DIR_CANDIDATE =
    path.resolve(
        __dirname,
        String(
            process.env.PUBLIC_DIR ||
            "public"
        )
    );


/*
Development:
ถ้ายังไม่มี /public
ใช้ Project Root ชั่วคราว

Staging / Production:
ต้องมี /public
*/

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


/* =========================================================
   CUSTOM SOUND CONFIG
========================================================= */

const CUSTOM_SOUND_MIN_AMOUNT =
    100;


const CUSTOM_SOUND_MAX_BYTES =
    3 * 1024 * 1024;


const CUSTOM_SOUND_TTL_MS =
    30 * 60 * 1000;


const CUSTOM_SOUND_AFTER_USE_TTL_MS =
    15 * 60 * 1000;


const CUSTOM_SOUND_DIR =
    path.join(
        DATA_DIR,
        "custom-audio"
    );


/* =========================================================
   CREATE DATA DIRECTORY
========================================================= */

fs.mkdirSync(
    DATA_DIR,
    {
        recursive:
            true
    }
);


/* =========================================================
   LOCAL ONE-TIME MIGRATION
========================================================= */

const LEGACY_DB_PATH =
    path.join(
        __dirname,
        "donations.db"
    );


const LEGACY_CUSTOM_SOUND_DIR =
    path.join(
        __dirname,
        ".amr29-private",
        "custom-audio"
    );


if (
    IS_DEVELOPMENT
    &&
    DB_PATH !==
    LEGACY_DB_PATH
    &&
    !fs.existsSync(
        DB_PATH
    )
    &&
    fs.existsSync(
        LEGACY_DB_PATH
    )
) {

    fs.copyFileSync(
        LEGACY_DB_PATH,
        DB_PATH
    );


    console.log(
        "📦 Local DB migrated ->",
        DB_PATH
    );
}


/* =========================================================
   MIGRATE CUSTOM SOUNDS
========================================================= */

if (
    IS_DEVELOPMENT
    &&
    !fs.existsSync(
        CUSTOM_SOUND_DIR
    )
    &&
    fs.existsSync(
        LEGACY_CUSTOM_SOUND_DIR
    )
) {

    try {

        fs.cpSync(
            LEGACY_CUSTOM_SOUND_DIR,
            CUSTOM_SOUND_DIR,
            {
                recursive:
                    true
            }
        );


        console.log(
            "📦 Local Custom Sounds migrated ->",
            CUSTOM_SOUND_DIR
        );


    } catch (error) {

        console.warn(
            "Custom Sound migration skipped:",
            error.message
        );
    }
}


/* =========================================================
   CONFIG VALIDATION
========================================================= */

function validateRuntimeConfig() {

    if (
        !ALLOWED_ENVIRONMENTS
            .includes(
                APP_ENV
            )
    ) {

        throw new Error(
            `APP_ENV ไม่ถูกต้อง: ${APP_ENV} (ใช้ development / staging / production)`
        );
    }


    if (
        !Number.isFinite(
            PORT
        )
        ||
        PORT <= 0
    ) {

        throw new Error(
            "PORT ไม่ถูกต้อง"
        );
    }


    /*
    Local ไม่ต้องบังคับค่า Production
    */

    if (
        !IS_DEPLOYED
    ) {

        return;
    }


    const required = [

        "ADMIN_KEY",

        "PROMPTPAY_ID",

        "EASYSLIP_API_KEY",

        "PUBLIC_BASE_URL"
    ];


    const missing =
        required.filter(
            key =>

                !String(
                    process.env[key]
                    ||
                    ""
                )
                    .trim()
        );


    if (
        missing.length >
        0
    ) {

        throw new Error(
            `Environment Variable ไม่ครบ: ${missing.join(", ")}`
        );
    }


    if (
        !/^https:\/\//i
            .test(
                PUBLIC_BASE_URL
            )
    ) {

        throw new Error(
            "Staging / Production ต้องใช้ PUBLIC_BASE_URL แบบ https://"
        );
    }


    if (
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
   EXPRESS
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


/* =========================================================
   SECURITY HEADERS
========================================================= */

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


/* =========================================================
   BODY PARSER
========================================================= */

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


/* =========================================================
   HEALTH CHECK
========================================================= */

app.get(
    "/health",

    (
        req,
        res
    ) => {

        res.set(
            "Cache-Control",
            "no-store"
        );


        return res.json({

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
                Date.now()
        });
    }
);


/* =========================================================
   VERSION API
========================================================= */

app.get(
    "/api/version",

    (
        req,
        res
    ) => {

        res.set(
            "Cache-Control",
            "no-store"
        );


        return res.json({

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
   LEGACY STATIC PROTECTION
========================================================= */

if (
    LEGACY_STATIC_MODE
) {

    app.use(
        (
            req,
            res,
            next
        ) => {

            let pathname =
                "";


            try {

                pathname =

                    decodeURIComponent(
                        req.path
                        ||
                        ""
                    )

                        .replace(
                            /\\/g,
                            "/"
                        )

                        .toLowerCase();


            } catch {

                return res
                    .status(
                        400
                    )
                    .end();
            }


            const blockedExact =
                new Set([

                    "/server.js",

                    "/package.json",

                    "/package-lock.json",

                    "/donations.db",

                    "/.env",

                    "/.env.local",

                    "/.gitignore"
                ]);


            const blockedPrefix = [

                "/data/",

                "/.amr29-private/",

                "/.git/",

                "/node_modules/"
            ];


            const blocked =

                blockedExact
                    .has(
                        pathname
                    )

                ||

                blockedPrefix
                    .some(
                        prefix =>

                            pathname
                                .startsWith(
                                    prefix
                                )
                    )

                ||

                pathname
                    .endsWith(
                        ".db"
                    )

                ||

                pathname
                    .endsWith(
                        ".sqlite"
                    )

                ||

                pathname
                    .endsWith(
                        ".sqlite3"
                    );


            if (
                blocked
            ) {

                return res
                    .status(
                        404
                    )
                    .end();
            }


            next();
        }
    );
}


/* =========================================================
   STATIC
========================================================= */

app.use(
    express.static(
        PUBLIC_DIR,
        {

            dotfiles:
                "deny",


            index:
                "index.html",


            etag:
                true,


            maxAge:

                IS_PRODUCTION

                    ?

                    "1h"

                    :

                    0,


            setHeaders:
                (
                    res,
                    filePath
                ) => {


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


                        return;
                    }


                    if (
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


/* =========================================================
   SQLITE
========================================================= */

const db =
    new sqlite3.Database(
        DB_PATH,

        error => {

            if (
                error
            ) {

                console.error(
                    "Database error:",
                    error
                );


                return;
            }


            console.log(
                "SQLite connected:",
                DB_PATH
            );
        }
    );


/* =========================================================
   DB HELPERS
========================================================= */

function dbRun(
    sql,
    params = []
) {

    return new Promise(
        (
            resolve,
            reject
        ) => {

            db.run(
                sql,
                params,

                function (
                    error
                ) {

                    if (
                        error
                    ) {

                        return reject(
                            error
                        );
                    }


                    resolve({

                        lastID:
                            this.lastID,

                        changes:
                            this.changes
                    });
                }
            );
        }
    );
}


function dbGet(
    sql,
    params = []
) {

    return new Promise(
        (
            resolve,
            reject
        ) => {

            db.get(
                sql,
                params,

                (
                    error,
                    row
                ) => {

                    if (
                        error
                    ) {

                        return reject(
                            error
                        );
                    }


                    resolve(
                        row
                    );
                }
            );
        }
    );
}


function dbAll(
    sql,
    params = []
) {

    return new Promise(
        (
            resolve,
            reject
        ) => {

            db.all(
                sql,
                params,

                (
                    error,
                    rows
                ) => {

                    if (
                        error
                    ) {

                        return reject(
                            error
                        );
                    }


                    resolve(
                        rows
                    );
                }
            );
        }
    );
}


/* =========================================================
   DEFAULT SETTINGS
========================================================= */

const defaultSettings = {

    /* GOAL */

    goal_title:
        "เป้าหมายสนับสนุน",

    goal_target:
        "5000",

    goal_enabled:
        "1",

    goal_base_total:
        "0",


    /* ALERT */

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
        "4500"
};


/* =========================================================
   DATABASE MIGRATION
========================================================= */

async function ensureColumn(
    tableName,
    columnName,
    definition
) {

    const columns =
        await dbAll(
            `PRAGMA table_info(${tableName})`
        );


    const exists =
        columns.some(
            column =>
                column.name ===
                columnName
        );


    if (
        exists
    ) {

        return;
    }


    await dbRun(
        `
        ALTER TABLE ${tableName}
        ADD COLUMN ${columnName}
        ${definition}
        `
    );


    console.log(
        `DB migration: ${tableName}.${columnName} added`
    );
}


/* =========================================================
   INIT DATABASE
========================================================= */

async function initDatabase() {

    await fs.promises.mkdir(
        CUSTOM_SOUND_DIR,
        {
            recursive:
                true
        }
    );


    await dbRun(`
        CREATE TABLE IF NOT EXISTS donations (

            id INTEGER PRIMARY KEY AUTOINCREMENT,

            name TEXT NOT NULL,

            message TEXT,

            amount REAL NOT NULL,

            trans_ref TEXT UNIQUE,

            created_at DATETIME
                DEFAULT CURRENT_TIMESTAMP
        )
    `);


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

            amount REAL NOT NULL,

            status TEXT NOT NULL
                DEFAULT 'pending',

            created_at INTEGER NOT NULL,

            expires_at INTEGER NOT NULL,

            verified_at INTEGER,

            trans_ref TEXT,

            custom_sound_token TEXT
        )
    `);


    await ensureColumn(
        "mobile_sessions",
        "custom_sound_token",
        "TEXT"
    );


    await dbRun(`
        CREATE INDEX IF NOT EXISTS
        idx_mobile_sessions_expires_at

        ON mobile_sessions (
            expires_at
        )
    `);


    await dbRun(`
        CREATE INDEX IF NOT EXISTS
        idx_mobile_sessions_status

        ON mobile_sessions (
            status
        )
    `);


    await dbRun(`
        CREATE TABLE IF NOT EXISTS custom_sounds (

            token TEXT PRIMARY KEY,

            file_name TEXT NOT NULL,

            original_name TEXT,

            mime_type TEXT NOT NULL,

            size INTEGER NOT NULL,

            status TEXT NOT NULL
                DEFAULT 'pending',

            created_at INTEGER NOT NULL,

            expires_at INTEGER NOT NULL,

            used_at INTEGER
        )
    `);


    await dbRun(`
        CREATE INDEX IF NOT EXISTS
        idx_custom_sounds_expires_at

        ON custom_sounds (
            expires_at
        )
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
            INSERT OR IGNORE
            INTO settings
            (
                key,
                value
            )

            VALUES (?, ?)
            `,
            [
                key,
                value
            ]
        );
    }
}


/* =========================================================
   MULTER - SLIP
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


        fileFilter:
            (
                req,
                file,
                callback
            ) => {

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


/* =========================================================
   MULTER - CUSTOM SOUND
========================================================= */

const audioUpload =
    multer({

        storage:
            multer.memoryStorage(),


        limits: {

            fileSize:
                CUSTOM_SOUND_MAX_BYTES
        },


        fileFilter:
            (
                req,
                file,
                callback
            ) => {

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
   SETTINGS
========================================================= */

async function getSettings() {

    try {

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


    } catch (error) {

        console.error(
            "Settings DB error:",
            error
        );


        return {

            ...defaultSettings
        };
    }
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

            value =
            excluded.value
        `,
        [
            key,

            String(
                value
            )
        ]
    );
}


/* =========================================================
   BOOLEAN
========================================================= */

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


/* =========================================================
   ALERT SETTINGS
========================================================= */

async function getAlertSettings() {

    const settings =
        await getSettings();


    const numberOr =
        (
            value,
            fallback
        ) => {

            const number =
                Number(
                    value
                );


            return Number.isFinite(
                number
            )

                ?

                number

                :

                fallback;
        };


    return {

        ttsEnabled:

            settings
                .alert_tts_enabled

            ===

            "1",


        readMessage:

            settings
                .alert_read_message

            ===

            "1",


        ttsRate:

            numberOr(
                settings
                    .alert_tts_rate,
                1
            ),


        bigAmount:

            numberOr(
                settings
                    .alert_big_amount,
                500
            ),


        megaAmount:

            numberOr(
                settings
                    .alert_mega_amount,
                1000
            ),


        afterTtsDelay:

            numberOr(
                settings
                    .alert_after_tts_delay,
                1000
            ),


        noTtsDisplayTime:

            numberOr(
                settings
                    .alert_no_tts_display_time,
                4500
            )
    };
}


async function emitAlertSettingsUpdate() {

    try {

        const settings =
            await getAlertSettings();


        io.emit(
            "alert-settings-update",
            settings
        );


    } catch (error) {

        console.error(
            "Emit Alert Settings Error:",
            error
        );
    }
}


/* =========================================================
   TOTAL
========================================================= */

async function getAllDonationTotal() {

    try {

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
            row?.total ||
            0
        );


    } catch (error) {

        console.error(
            "Donation total error:",
            error
        );


        return 0;
    }
}


/* =========================================================
   TOP DONORS
========================================================= */

async function getTopDonorsFromDB() {

    try {

        const rows =
            await dbAll(`
                SELECT

                    name,

                    SUM(amount)
                    AS amount

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


    } catch (error) {

        console.error(
            "Ranking DB error:",
            error
        );


        return [];
    }
}


/* =========================================================
   GOAL
========================================================= */

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

            settings.goal_enabled

            ===

            "1"
    };
}


async function emitGoalUpdate() {

    const goal =
        await getDonationGoal();


    io.emit(
        "goal-update",
        goal
    );
}


/* =========================================================
   ADMIN AUTH
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


/* =========================================================
   SOCKET.IO
========================================================= */

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
   EASYSLIP
========================================================= */

async function verifySlipWithEasySlip(
    file,
    amount
) {

    const apiKey =
        String(
            process.env
                .EASYSLIP_API_KEY
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
            await response
                .json();


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

            data.error
                ?.message

            ||

            data.message

            ||

            "ตรวจสอบสลิปไม่สำเร็จ"
        );
    }


    if (
        data.data
            ?.isDuplicate

        ===

        true
    ) {

        throw new Error(
            "สลิปนี้ถูกใช้ไปแล้ว ไม่สามารถใช้ซ้ำได้"
        );
    }


    if (
        !data.data
            ?.matchedAccount
    ) {

        throw new Error(
            "บัญชีผู้รับไม่ถูกต้อง กรุณาโอนเข้าบัญชีที่กำหนด"
        );
    }


    if (
        data.data
            ?.isAmountMatched

        !==

        true
    ) {

        throw new Error(
            "ยอดเงินในสลิปไม่ตรงกับยอดโดเนท"
        );
    }


    return data;
}


/* =========================================================
   VALIDATE DONATION
========================================================= */

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
        .trim();


    const message =
        String(
            body.message
            ||
            ""
        )
        .trim();


    if (
        !name
    ) {

        name =
            "Anonymous";
    }


    if (
        !Number.isFinite(
            amount
        )

        ||

        amount < 10
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

        message
    };
}


/* =========================================================
   NORMALIZE EASYSLIP
========================================================= */

function normalizeDonationFromEasySlip(
    input,
    data
) {

    const amountInSlip =
        Number(
            data.data
                ?.amountInSlip
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


    return {

        name:
            input.name,


        message:
            input.message,


        amount:
            amountInSlip,


        transRef:

            data.data
                ?.rawSlip
                ?.transRef

            ||

            data.data
                ?.transRef

            ||

            null
    };
}


/* =========================================================
   SOUND TIERS
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
            "1-49",

        soundUrl:
            "/sounds/alert.mp3"
    };
}


/* =========================================================
   CUSTOM SOUND TOKEN
========================================================= */

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


/* =========================================================
   NORMALIZE CUSTOM TOKEN
========================================================= */

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


    if (
        !/^snd_[a-f0-9]{48}$/
        .test(
            token
        )
    ) {

        return null;
    }


    return token;
}


/* =========================================================
   AUDIO EXTENSION
========================================================= */

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


/* =========================================================
   GET CUSTOM SOUND
========================================================= */

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


/* =========================================================
   CHECK CUSTOM SOUND
========================================================= */

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


    const filePath =
        path.join(
            CUSTOM_SOUND_DIR,
            record.file_name
        );


    try {

        await fs.promises.access(
            filePath,
            fs.constants.R_OK
        );


        return true;


    } catch {

        return false;
    }
}


/* =========================================================
   RESOLVE DONATION SOUND
========================================================= */

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


    const usable =
        await customSoundIsUsable(
            token,
            amount
        );


    if (
        !usable
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

            `/api/custom-sound/${encodeURIComponent(
                token
            )}/audio`,


        customSound:
            true,


        soundToken:
            token
    };
}


/* =========================================================
   MARK CUSTOM SOUND USED
========================================================= */

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


/* =========================================================
   SAVE CUSTOM SOUND
========================================================= */

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


    } catch (error) {

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


/* =========================================================
   CLEANUP CUSTOM SOUNDS
========================================================= */

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

            const filePath =
                path.join(
                    CUSTOM_SOUND_DIR,
                    item.file_name
                );


            await fs.promises.unlink(
                filePath
            )
            .catch(
                () => {}
            );
        }


        if (
            expired.length >
            0
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


    } catch (error) {

        console.error(
            "Custom Sound Cleanup:",
            error
        );
    }
}


/* =========================================================
   SAVE DONATION
========================================================= */

async function saveDonation(
    donation
) {

    if (
        !donation
            .transRef
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

                    trans_ref
                )

                VALUES (?, ?, ?, ?)
                `,
                [
                    donation.name,

                    donation.message,

                    donation.amount,

                    donation.transRef
                ]
            );


        console.log(
            "Donation saved ID:",
            result.lastID
        );


        console.log(
            "DONATION VERIFIED:",
            {

                name:
                    donation.name,

                amount:
                    donation.amount,

                customSound:
                    donation.customSound,

                soundTier:
                    donation.soundTier
            }
        );


        return result;


    } catch (error) {

        if (
            String(
                error.message
            )
            .includes(
                "UNIQUE constraint failed"
            )
        ) {

            throw new Error(
                "รายการนี้ถูกบันทึกไปแล้ว"
            );
        }


        throw error;
    }
}


/* =========================================================
   BROADCAST
========================================================= */

async function broadcastDonation(
    donation
) {

    io.emit(
        "donation",
        donation
    );


    const donors =
        await getTopDonorsFromDB();


    io.emit(
        "ranking-update",
        donors
    );


    await emitGoalUpdate();
}


/* =========================================================
   MOBILE SESSION ID
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


/* =========================================================
   CREATE MOBILE SESSION DB
========================================================= */

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

            custom_sound_token
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
            null
        ]
    );


    return session;
}


/* =========================================================
   GET MOBILE SESSION DB
========================================================= */

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

                custom_sound_token

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

            null
    };
}


/* =========================================================
   DELETE MOBILE SESSION
========================================================= */

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


/* =========================================================
   LOCK MOBILE SESSION
========================================================= */

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


    return (

        result.changes

        ===

        1
    );
}


/* =========================================================
   RESET MOBILE SESSION
========================================================= */

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


/* =========================================================
   SAVE MOBILE DONATION
   + COMPLETE SESSION
========================================================= */

async function saveMobileDonationAndComplete(
    sessionId,
    donation
) {

    try {

        await dbRun(
            "BEGIN IMMEDIATE TRANSACTION"
        );


        const insertResult =
            await dbRun(
                `
                INSERT INTO donations
                (
                    name,

                    message,

                    amount,

                    trans_ref
                )

                VALUES (?, ?, ?, ?)
                `,
                [
                    donation.name,

                    donation.message,

                    donation.amount,

                    donation.transRef
                ]
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
                ]
            );


        if (
            updateResult.changes
            !==
            1
        ) {

            throw new Error(
                "ไม่สามารถยืนยัน Mobile Session ได้"
            );
        }


        await dbRun(
            "COMMIT"
        );


        console.log(
            "Donation saved ID:",
            insertResult.lastID
        );


        return insertResult;


    } catch (error) {

        await dbRun(
            "ROLLBACK"
        )
        .catch(
            () => {}
        );


        if (
            String(
                error.message
            )
            .includes(
                "UNIQUE constraint failed"
            )
        ) {

            throw new Error(
                "รายการนี้ถูกบันทึกไปแล้ว"
            );
        }


        throw error;
    }
}


/* =========================================================
   CLEAN MOBILE SESSIONS
========================================================= */

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


    } catch (error) {

        console.error(
            "Mobile Session Cleanup:",
            error
        );
    }
}


/* =========================================================
   RECOVER MOBILE SESSION
========================================================= */

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


    } catch (error) {

        console.error(
            "Mobile Session Recovery:",
            error
        );
    }
}


/* =========================================================
   PUBLIC BASE URL
========================================================= */

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

        req.protocol;


    return (

        `${protocol}://${req.get("host")}`
    )

        .replace(
            /\/+$/,
            ""
        );
}


/* =========================================================
   CUSTOM SOUND UPLOAD API
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

            const amount =
                Number(
                    req.body.amount
                );


            const result =
                await saveUploadedCustomSound(
                    req.file,
                    amount
                );


            return res.json({

                success:
                    true,

                message:
                    "อัปโหลด Custom Sound แล้ว",

                customSound:
                    result
            });


        } catch (error) {

            console.error(
                "Custom Sound Upload Error:",
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

                        "อัปโหลดเสียงไม่สำเร็จ"
                });
        }
    }
);


/* =========================================================
   CUSTOM SOUND STREAM
========================================================= */

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
            ) {

                return res
                    .status(
                        404
                    )
                    .end();
            }


            if (
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


            return res.sendFile(
                filePath
            );


        } catch (error) {

            console.error(
                "Custom Sound Stream Error:",
                error
            );


            return res
                .status(
                    404
                )
                .end();
        }
    }
);


/* =========================================================
   PROMPTPAY QR
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

                amount < 10
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
                    process.env
                        .PROMPTPAY_ID
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
                await QRCode
                    .toDataURL(
                        payload
                    );


            return res.json({

                success:
                    true,

                qr,

                amount
            });


        } catch (error) {

            console.error(
                "QR ERROR:",
                error
            );


            return res
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


/* =========================================================
   DESKTOP VERIFY
========================================================= */

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


            const sound =
                await resolveDonationSound(

                    donation.amount,

                    req.body
                        .customSoundToken
                );


            Object.assign(
                donation,
                sound
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
                    error => {

                        console.error(
                            "Mark Custom Sound Used Error:",
                            error
                        );
                    }
                );
            }


            await broadcastDonation(
                donation
            );


            return res.json({

                success:
                    true,

                message:
                    "ตรวจสอบสลิปสำเร็จ",

                donation,

                data:
                    data.data
            });


        } catch (error) {

            console.error(
                "VERIFY ERROR:",
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

                        "ตรวจสอบสลิปไม่สำเร็จ"
                });
        }
    }
);


/* =========================================================
   TOP DONORS
========================================================= */

app.get(
    "/top-donors",

    async (
        req,
        res
    ) => {

        const donors =
            await getTopDonorsFromDB();


        return res.json({

            success:
                true,

            donors
        });
    }
);


/* =========================================================
   PUBLIC GOAL
========================================================= */

app.get(
    "/api/goal",

    async (
        req,
        res
    ) => {

        try {

            const goal =
                await getDonationGoal();


            return res.json({

                success:
                    true,

                ...goal
            });


        } catch (error) {

            console.error(
                "Public Goal Error:",
                error
            );


            return res
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


/* =========================================================
   ADMIN GET GOAL
========================================================= */

app.get(
    "/api/admin/goal",

    requireAdminKey,

    async (
        req,
        res
    ) => {

        try {

            const goal =
                await getDonationGoal();


            return res.json({

                success:
                    true,

                goal
            });


        } catch (error) {

            console.error(
                "Admin Get Goal:",
                error
            );


            return res
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


/* =========================================================
   UPDATE GOAL
========================================================= */

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

                target <= 0
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


            return res.json({

                success:
                    true,

                goal
            });


        } catch (error) {

            console.error(
                "Update Goal Error:",
                error
            );


            return res
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


/* =========================================================
   RESET GOAL
========================================================= */

app.post(
    "/api/admin/goal/reset",

    requireAdminKey,

    async (
        req,
        res
    ) => {

        try {

            const total =
                await getAllDonationTotal();


            await setSetting(
                "goal_base_total",
                total
            );


            const goal =
                await getDonationGoal();


            io.emit(
                "goal-update",
                goal
            );


            return res.json({

                success:
                    true,

                goal
            });


        } catch (error) {

            console.error(
                "Reset Goal Error:",
                error
            );


            return res
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
   PUBLIC ALERT SETTINGS
========================================================= */

app.get(
    "/api/alert-settings",

    async (
        req,
        res
    ) => {

        try {

            const settings =
                await getAlertSettings();


            return res.json({

                success:
                    true,

                settings
            });


        } catch (error) {

            console.error(
                "Get Alert Settings Error:",
                error
            );


            return res
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


/* =========================================================
   ADMIN GET ALERT SETTINGS
========================================================= */

app.get(
    "/api/admin/alert-settings",

    requireAdminKey,

    async (
        req,
        res
    ) => {

        try {

            const settings =
                await getAlertSettings();


            return res.json({

                success:
                    true,

                settings
            });


        } catch (error) {

            console.error(
                "Admin Get Alert Settings Error:",
                error
            );


            return res
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


/* =========================================================
   UPDATE ALERT SETTINGS
========================================================= */

app.post(
    "/api/admin/alert-settings",

    requireAdminKey,

    async (
        req,
        res
    ) => {

        try {

            const ttsEnabled =
                toBoolean(
                    req.body.ttsEnabled
                );


            const readMessage =
                toBoolean(
                    req.body.readMessage
                );


            const ttsRate =
                Number(
                    req.body.ttsRate
                );


            const bigAmount =
                Number(
                    req.body.bigAmount
                );


            const megaAmount =
                Number(
                    req.body.megaAmount
                );


            const afterTtsDelay =
                Number(
                    req.body.afterTtsDelay
                );


            const noTtsDisplayTime =
                Number(
                    req.body.noTtsDisplayTime
                );


            if (
                !Number.isFinite(
                    ttsRate
                )

                ||

                ttsRate < .5

                ||

                ttsRate > 2
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
                    bigAmount
                )

                ||

                bigAmount <= 0
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

                afterTtsDelay < 0

                ||

                afterTtsDelay > 10000
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

                noTtsDisplayTime < 1000

                ||

                noTtsDisplayTime > 30000
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
                )
            ]);


            const settings =
                await getAlertSettings();


            await emitAlertSettingsUpdate();


            return res.json({

                success:
                    true,

                message:
                    "บันทึก Alert Settings แล้ว",

                settings
            });


        } catch (error) {

            console.error(
                "Update Alert Settings Error:",
                error
            );


            return res
                .status(
                    500
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
   CREATE MOBILE SESSION
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

                    req.body
                        .customSoundToken
                );


            let customSoundToken =
                null;


            if (
                requestedToken

                &&

                input.amount >=
                CUSTOM_SOUND_MIN_AMOUNT
            ) {

                const usable =
                    await customSoundIsUsable(

                        requestedToken,

                        input.amount
                    );


                if (
                    usable
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


                customSoundToken
            };


            await createMobileSessionDB(
                session
            );


            const baseUrl =
                getPublicBaseUrl(
                    req
                );


            const uploadUrl =

                `${baseUrl}/mobile-upload.html?session=${encodeURIComponent(
                    sessionId
                )}`;


            const qr =
                await QRCode
                    .toDataURL(
                        uploadUrl
                    );


            console.log(
                "📱 Mobile Session created:",
                sessionId
            );


            return res.json({

                success:
                    true,

                sessionId,

                uploadUrl,

                qr,

                expiresAt,


                customSoundAccepted:

                    Boolean(
                        customSoundToken
                    )
            });


        } catch (error) {

            console.error(
                "Create Mobile Session:",
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

                        "สร้าง Mobile Upload ไม่สำเร็จ"
                });
        }
    }
);


/* =========================================================
   GET MOBILE SESSION
========================================================= */

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
                Date.now()
                >
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


            return res.json({

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
                        )
                }
            });


        } catch (error) {

            console.error(
                "Get Mobile Session:",
                error
            );


            return res
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


/* =========================================================
   MOBILE VERIFY
========================================================= */

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
                Date.now()
                >
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
                            session.message
                    },

                    data
                );


            const sound =
                await resolveDonationSound(

                    donation.amount,

                    session.customSoundToken
                );


            Object.assign(
                donation,
                sound
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
                    error => {

                        console.error(
                            "Mark Mobile Custom Sound Used Error:",
                            error
                        );
                    }
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


            return res.json({

                success:
                    true,

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
                locked

                &&

                sessionId
            ) {

                await resetMobileSession(
                    sessionId
                )
                .catch(
                    resetError => {

                        console.error(
                            "Reset Mobile Session Error:",
                            resetError
                        );
                    }
                );
            }


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

                        "ตรวจสอบสลิปไม่สำเร็จ"
                });
        }
    }
);


/* =========================================================
   TEST DONATION
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
                    req.body
                        ?.name
                    ||
                    "AMR29 Test"
                )
                .trim()
                .slice(
                    0,
                    30
                );


            const message =
                String(
                    req.body
                        ?.message
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
                    req.body
                        ?.amount
                );


            if (
                !Number.isFinite(
                    amount
                )

                ||

                amount <= 0
            ) {

                return res
                    .status(
                        400
                    )
                    .json({

                        success:
                            false,

                        message:
                            "จำนวนเงินไม่ถูกต้อง"
                    });
            }


            const tier =
                getDonationTierSound(
                    amount
                );


            const donation = {

                name:

                    name

                    ||

                    "AMR29 Test",


                message,

                amount,


                ...tier,


                customSound:
                    false,


                soundToken:
                    null,


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
                "🧪 TEST DONATION:",
                donation
            );


            return res.json({

                success:
                    true,

                donation
            });


        } catch (error) {

            console.error(
                "Test Donation Error:",
                error
            );


            return res
                .status(
                    500
                )
                .json({

                    success:
                        false,

                    message:
                        "ส่ง Test Donation ไม่สำเร็จ"
                });
        }
    }
);


/* =========================================================
   REPLAY DONATION
========================================================= */

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

                donationId <= 0
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


            const tier =
                getDonationTierSound(
                    donation.amount
                );


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


                ...tier,


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


                createdAt:
                    Date.now()
            };


            io.emit(
                "donation",
                replayDonation
            );


            return res.json({

                success:
                    true,

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


            return res
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

                            COUNT(*)
                            AS count,

                            COALESCE(
                                SUM(amount),
                                0
                            )
                            AS total

                        FROM donations

                        WHERE

                            date(
                                created_at,
                                'localtime'
                            )

                            =

                            date(
                                'now',
                                'localtime'
                            )
                    `),


                    dbGet(`
                        SELECT

                            COUNT(*)
                            AS count,

                            COALESCE(
                                SUM(amount),
                                0
                            )
                            AS total

                        FROM donations

                        WHERE

                            strftime(
                                '%Y-%m',
                                created_at,
                                'localtime'
                            )

                            =

                            strftime(
                                '%Y-%m',
                                'now',
                                'localtime'
                            )
                    `),


                    dbGet(`
                        SELECT

                            COUNT(*)
                            AS count,

                            COALESCE(
                                SUM(amount),
                                0
                            )
                            AS total

                        FROM donations
                    `),


                    dbAll(`
                        SELECT

                            id,

                            name,

                            message,

                            amount,

                            created_at

                        FROM donations

                        ORDER BY id DESC

                        LIMIT 12
                    `),


                    getTopDonorsFromDB(),

                    getDonationGoal(),

                    getAlertSettings()

                ]);


            return res.json({

                success:
                    true,


                stats: {


                    today: {

                        count:

                            Number(
                                today
                                    ?.count
                                ||
                                0
                            ),

                        total:

                            Number(
                                today
                                    ?.total
                                ||
                                0
                            )
                    },


                    month: {

                        count:

                            Number(
                                month
                                    ?.count
                                ||
                                0
                            ),

                        total:

                            Number(
                                month
                                    ?.total
                                ||
                                0
                            )
                    },


                    all: {

                        count:

                            Number(
                                all
                                    ?.count
                                ||
                                0
                            ),

                        total:

                            Number(
                                all
                                    ?.total
                                ||
                                0
                            )
                    }
                },


                recent,

                topDonors,

                goal,

                alertSettings
            });


        } catch (error) {

            console.error(
                "Dashboard error:",
                error
            );


            return res
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
   MULTER ERROR
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
        ) {

            if (
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
   START
========================================================= */

async function start() {

    try {


        validateRuntimeConfig();


        await initDatabase();


        await cleanupMobileSessions();


        await recoverMobileSessions();


        await cleanupCustomSounds();


        setInterval(
            () => {


                cleanupMobileSessions()
                    .catch(
                        error => {

                            console.error(
                                "Mobile cleanup interval:",
                                error
                            );
                        }
                    );


                cleanupCustomSounds()
                    .catch(
                        error => {

                            console.error(
                                "Custom sound cleanup interval:",
                                error
                            );
                        }
                    );


            },

            60 * 1000
        )
            .unref();


        server.listen(

            PORT,

            "0.0.0.0",

            () => {


                const displayBaseUrl =

                    PUBLIC_BASE_URL

                    ||

                    `http://localhost:${PORT}`;


                console.log("");


                console.log(
                    "=============================================="
                );


                console.log(
                    "           AMR29 DONATE SERVER"
                );


                console.log(
                    "=============================================="
                );


                console.log(
                    "Environment:   ",
                    APP_ENV
                );


                console.log(
                    "Version:       ",
                    APP_VERSION
                );


                console.log(
                    "Port:          ",
                    PORT
                );


                console.log(
                    "Public URL:    ",
                    displayBaseUrl
                );


                console.log(
                    "Public Dir:    ",
                    PUBLIC_DIR
                );


                console.log(
                    "Data Dir:      ",
                    DATA_DIR
                );


                console.log(
                    "Database:      ",
                    DB_PATH
                );


                console.log(
                    "Custom Audio:  ",
                    CUSTOM_SOUND_DIR
                );


                console.log("");


                if (
                    LEGACY_STATIC_MODE
                ) {

                    console.warn(
                        "⚠ DEVELOPMENT COMPATIBILITY MODE"
                    );


                    console.warn(
                        "  HTML ยังอยู่ Project Root"
                    );


                    console.warn(
                        "  server.js / DB / .env / data ถูก Block แล้ว"
                    );


                    console.warn(
                        "  ขั้นต่อไปค่อยย้ายหน้าเว็บเข้า /public"
                    );


                    console.log("");
                }


                console.log(
                    `Donate:        ${displayBaseUrl}`
                );


                console.log(
                    `Dashboard:     ${displayBaseUrl}/dashboard.html`
                );


                console.log(
                    `OBS Overlay:   ${displayBaseUrl}/overlay.html`
                );


                console.log(
                    `Goal Overlay:  ${displayBaseUrl}/goal-overlay.html`
                );


                console.log(
                    `Health:        ${displayBaseUrl}/health`
                );


                console.log(
                    `Version API:   ${displayBaseUrl}/api/version`
                );


                console.log("");


                console.log(
                    "Sound Tiers:"
                );


                console.log(
                    "  10-49      -> alert.mp3"
                );


                console.log(
                    "  50-99      -> alert2.mp3"
                );


                console.log(
                    "  100-299    -> alert3.mp3 + Custom Sound"
                );


                console.log(
                    "  300-499    -> alert4.mp3 + Custom Sound"
                );


                console.log(
                    "  500-999    -> alert5.mp3 + Custom Sound"
                );


                console.log(
                    "  1000+      -> alert5.mp3 + Custom Sound"
                );


                console.log("");


                console.log(
                    "Environment Variables:"
                );


                console.log(

                    "  ADMIN_KEY:       ",

                    process.env.ADMIN_KEY

                        ?

                        "Loaded ✓"

                        :

                        "NOT SET ✗"
                );


                console.log(

                    "  PROMPTPAY_ID:    ",

                    process.env.PROMPTPAY_ID

                        ?

                        "Loaded ✓"

                        :

                        "NOT SET ✗"
                );


                console.log(

                    "  EASYSLIP:        ",

                    process.env
                        .EASYSLIP_API_KEY

                        ?

                        "Loaded ✓"

                        :

                        "NOT SET ✗"
                );


                console.log(

                    "  PUBLIC_BASE_URL: ",

                    PUBLIC_BASE_URL

                    ||

                    "Auto / Not set"
                );


                console.log(
                    "=============================================="
                );
            }
        );


    } catch (error) {


        console.error(
            "Server startup failed:",
            error
        );


        process.exit(
            1
        );
    }
}


/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

let shuttingDown =
    false;


function shutdown(
    signal
) {

    if (
        shuttingDown
    ) {

        return;
    }


    shuttingDown =
        true;


    console.log(

        `\n${signal} received - shutting down...`
    );


    const forceExitTimer =
        setTimeout(
            () => {

                console.error(
                    "Forced shutdown"
                );


                process.exit(
                    1
                );
            },

            10000
        );


    forceExitTimer
        .unref();


    server.close(
        () => {


            db.close(
                error => {


                    if (
                        error
                    ) {

                        console.error(
                            "SQLite close error:",
                            error
                        );


                        process.exit(
                            1
                        );


                        return;
                    }


                    console.log(
                        "AMR29 Donate stopped safely"
                    );


                    process.exit(
                        0
                    );
                }
            );
        }
    );
}


/* =========================================================
   HOST RESTART
========================================================= */

process.on(
    "SIGTERM",

    () =>
        shutdown(
            "SIGTERM"
        )
);


/* =========================================================
   CTRL + C
========================================================= */

process.on(
    "SIGINT",

    () =>
        shutdown(
            "SIGINT"
        )
);


/* =========================================================
   START SERVER
========================================================= */

start();