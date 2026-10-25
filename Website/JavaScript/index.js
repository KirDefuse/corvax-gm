require("dotenv").config();

const path = require("path");
const { google } = require("googleapis");
const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database(
    path.join(__dirname, "..", "DataBase", "database.db")
);


// ---------- Приведение дат периодов к формату YYYY-MM-DD ----------
async function normalizePeriodDates() {
    for (const col of ["start_date", "end_date"]) {
        await run(
            `UPDATE periods
             SET ${col} = substr(${col}, 7, 4) || '-' || substr(${col}, 4, 2) || '-' || substr(${col}, 1, 2)
             WHERE ${col} LIKE '__.__.____'`
        );
    }
}

// ---------- Обёртки над sqlite ----------
const run = (sql, params = []) =>
    new Promise((resolve, reject) =>
        db.run(sql, params, function (err) {
            err ? reject(err) : resolve(this);
        })
    );

const get = (sql, params = []) =>
    new Promise((resolve, reject) =>
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))
    );

// ---------- Google ----------
const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_KEY_FILE,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
});

async function readSheet(spreadsheetId, range) {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: client });
    const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    return response.data.values || [];
}

// ---------- Столбцы листа "Event list" (индексы с нуля: A=0, B=1, ...) ----------
const EVENT_COLS = {
    dsid: 0,     // A - DSID (Discord ID ведущего)
    server: 2,   // C - Сервер
    roundId: 3,  // D - Раунд
    size: 4,     // E - Размер
    desc: 5,     // F - Описание
    date: 8,     // I - "Дата" (d.m.yyyy)
};


// ---------- Преобразует дату в формат YYYY-MM-DD ----------

function normalizeDate(value) {
    if (!value) return null;

    const match = String(value).trim().match(
        /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/
    );

    if (!match) return null;

    const [, day, month, year] = match;

    const d = Number(day);
    const m = Number(month);
    const y = Number(year);

    // Проверяем, что дата действительно существует
    const date = new Date(Date.UTC(y, m - 1, d));

    if (
        date.getUTCFullYear() !== y ||
        date.getUTCMonth() !== m - 1 ||
        date.getUTCDate() !== d
    ) {
        return null;
    }

    return `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}


// ---------- Логирование синхронизаций ----------
async function withLog(type, fn) {
    const log = await run(
        `INSERT INTO sync_logs (sync_type, started_at, status)
         VALUES (?, CURRENT_TIMESTAMP, 'running')`,
        [type]
    );
    try {
        const processed = await fn();
        await run(
            `UPDATE sync_logs
             SET finished_at = CURRENT_TIMESTAMP, processed_rows = ?, status = 'ok'
             WHERE id = ?`,
            [processed, log.lastID]
        );
        console.log(`[${type}] обработано строк: ${processed}`);
    } catch (err) {
        await run(
            `UPDATE sync_logs
             SET finished_at = CURRENT_TIMESTAMP, status = 'error', error_message = ?
             WHERE id = ?`,
            [String(err.message), log.lastID]
        );
        throw err;
    }
}

// ---------- Автоматическое закрытие периодов ----------
async function updatePeriods() {
    const res = await run(
        `UPDATE periods
         SET is_closed = CASE
             WHEN end_date < date('now', 'localtime') THEN 1
             ELSE 0
         END
         WHERE is_closed != CASE
             WHEN end_date < date('now', 'localtime') THEN 1
             ELSE 0
         END`
    );
    if (res.changes) console.log(`[periods] статус изменён у периодов: ${res.changes}`);
}

// ---------- Синхронизация гмов ----------
async function syncUsers() {
    const rows = await readSheet(process.env.USERS_SHEET, "Redux!A:C");
    let count = 0;

    await run("BEGIN");
    try {
        for (const row of rows.slice(1)) {
            if (!row[0] || !row[2]) continue;

            const ckey = String(row[0]).trim();
            const discordId = String(row[2]).trim();

            // Если ckey сейчас числится за другим Discord ID - освобождаем его
            await run(
                `UPDATE users_gm
                 SET ckey = ckey || '__old_' || discord_id
                 WHERE ckey = ? AND discord_id != ?`,
                [ckey, discordId]
            );

            // Новый Discord ID добавляется, у существующего ckey перезаписывается
            await run(
                `INSERT INTO users_gm (discord_id, ckey)
                 VALUES (?, ?)
                 ON CONFLICT(discord_id)
                 DO UPDATE SET ckey = excluded.ckey`,
                [discordId, ckey]
            );
            count++;
        }
        await run("COMMIT");
    } catch (err) {
        await run("ROLLBACK");
        throw err;
    }
    return count;
}

// ---------- Синхронизация модеров ----------
async function syncUsersMod() {
    const rows = await readSheet(process.env.MOD_SHEET, "Модераторы!A:E");
    let count = 0;

    const activeDiscordIds = new Set();

    await run("BEGIN");
    try {
        for (const row of rows.slice(1)) {
            if (!row[0] || !row[4]) continue;

            const ckey = String(row[0]).trim();
            const server = String(row[2] || "").trim();
            const discordId = String(row[4]).trim();

            activeDiscordIds.add(discordId);

            await run(
                `INSERT INTO users_moderation (discord_id, ckey, server)
                 VALUES (?, ?, ?)
                 ON CONFLICT(discord_id)
                 DO UPDATE SET
                     ckey = excluded.ckey,
                     server = excluded.server`,
                [discordId, ckey, server]
            );

            count++;
        }

        // Удаляем тех, чьих discord_id больше нет в таблице
        if (activeDiscordIds.size > 0) {
            const placeholders = [...activeDiscordIds]
                .map(() => "?")
                .join(",");

            await run(
                `DELETE FROM users_moderation
                 WHERE discord_id NOT IN (${placeholders})`,
                [...activeDiscordIds]
            );
        } else {
            await run(`DELETE FROM users_moderation`);
        }

        await run("COMMIT");
    } catch (err) {
        await run("ROLLBACK");
        throw err;
    }

    return count;
}


// ---------- Синхронизация ивентов ----------
// Сколько последних записей перепроверять (ловит правки в недавних строках)
const RECHECK_LAST = 5;

async function syncEvents(full = false) {
    // Откуда начинать: за RECHECK_LAST строк до последней записи в базе
    const last = await get("SELECT MAX(id) AS maxId FROM events");
    const startRow = full || !last.maxId
        ? 2                                          // 1 - заголовки
        : Math.max(2, last.maxId - RECHECK_LAST + 1);

    console.log(`[events] читаю с строки ${startRow}${full ? " (полная синхронизация)" : ""}`);

    const rows = await readSheet(process.env.USERS_SHEET, `Event list!A${startRow}:I`);
    const C = EVENT_COLS;
    let count = 0;
    let skipped = 0;

    await run("BEGIN");
    try {
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const id = startRow + i;                 // номер строки в таблице -> events.id

            const dsid = row[C.dsid];
            const server = row[C.server];
            const size = row[C.size];
            const desc = row[C.desc];
            const rawDate = row[C.date];

            if (!dsid && !server && !size && !desc && !rawDate) continue;   // пустая строка
            if (!dsid || !server || !size || !desc || !rawDate) {
                console.warn(`Строка ${id}: не хватает данных, пропуск`);
                skipped++;
                continue;
            }

            const eventDate = normalizeDate(rawDate);
            if (!eventDate) {
                console.warn(`Строка ${id}: некорректная дата "${rawDate}", пропуск`);
                skipped++;
                continue;
            }

            const host = await get(
                "SELECT discord_id FROM users_gm WHERE discord_id = ?",
                [String(dsid).trim()]
            );
            if (!host) {
                console.warn(`Строка ${id}: DSID ${dsid} не найден в users_gm`);
                skipped++;
                continue;
            }

            const period = await get(
                "SELECT id FROM periods WHERE date(?) BETWEEN start_date AND end_date",
                [eventDate]
            );
            if (!period) {
                console.warn(`Строка ${id}: периода для даты ${eventDate} нет, пропуск`);
                skipped++;
                continue;
            }

            // Номер внутри периода: у уже существующего ивента сохраняем,
            // у нового - следующий после максимального в этом периоде
            const existing = await get(
                "SELECT period_id, event_number FROM events WHERE id = ?",
                [id]
            );
            let eventNumber;
            if (existing && existing.period_id === period.id) {
                eventNumber = existing.event_number;
            } else {
                const mx = await get(
                    "SELECT COALESCE(MAX(event_number), 0) AS n FROM events WHERE period_id = ?",
                    [period.id]
                );
                eventNumber = mx.n + 1;
            }

            const roundId = row[C.roundId] ? String(row[C.roundId]).trim() : null;

            await run(
                `INSERT INTO events
                    (id, period_id, event_number, event_date, server,
                     size, host_discord_id, description, round_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                    period_id       = excluded.period_id,
                    event_number    = excluded.event_number,
                    event_date      = excluded.event_date,
                    server          = excluded.server,
                    size            = excluded.size,
                    host_discord_id = excluded.host_discord_id,
                    description     = excluded.description,
                    round_id        = excluded.round_id`,
                [
                    id, period.id, eventNumber, eventDate,
                    String(server).trim(), String(size).trim(),
                    host.discord_id, String(desc).trim(), roundId
                ]
            );
            count++;
        }
        await run("COMMIT");
    } catch (err) {
        await run("ROLLBACK");
        throw err;
    }

    if (skipped) console.warn(`[events] пропущено строк: ${skipped}`);
    return count;
}

// ---------- Планировщик ----------
const HOUR = 60 * 60 * 1000;
const FULL_EVERY_DAYS = 2;

let busy = false;        // защита от наложения запусков
let firstRun = true;     // для флага --full при старте

async function fullIsDue() {
    const row = await get(
        `SELECT 1 AS ok FROM sync_logs
         WHERE sync_type = 'events_full' AND status = 'ok'
           AND started_at > datetime('now', ?)
         LIMIT 1`,
        [`-${FULL_EVERY_DAYS} days`]
    );
    return !row;   // свежей полной синхронизации нет -> пора
}

async function tick() {
    if (busy) {
        console.warn("Предыдущая синхронизация ещё идёт, пропускаю");
        return;
    }
    busy = true;
    try {
        console.log(`\n=== ${new Date().toLocaleString()} ===`);

        const forceFull = firstRun && process.argv.includes("--full");
        firstRun = false;
        const full = forceFull || await fullIsDue();

        await normalizePeriodDates();        // даты периодов -> YYYY-MM-DD
        await updatePeriods();               // актуализируем закрытые периоды
        await withLog("users_gm", syncUsers);
        await withLog("users_moderation", syncUsersMod);
        await withLog(full ? "events_full" : "events", () => syncEvents(full));
    } catch (err) {
        console.error(err);
    } finally {
        busy = false;
    }
}

tick();                         // сразу при запуске
setInterval(tick, HOUR);        // дальше каждый час

process.on("SIGINT", () => {    // Ctrl+C
    db.close(() => process.exit(0));
});