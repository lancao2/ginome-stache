use std::sync::Mutex;

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

pub struct Database(Mutex<Connection>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    id: i64,
    title: String,
    notes: String,
    due_date: Option<String>,
    due_time: Option<String>,
    priority: i64,
    done: bool,
    created_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInput {
    title: String,
    notes: Option<String>,
    due_date: Option<String>,
    due_time: Option<String>,
    priority: Option<i64>,
}

impl Database {
    pub fn open(app: &AppHandle) -> Result<Self, String> {
        let dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        let connection = Connection::open(dir.join("stache.db")).map_err(|error| error.to_string())?;
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 CREATE TABLE IF NOT EXISTS tasks (
                     id         INTEGER PRIMARY KEY AUTOINCREMENT,
                     title      TEXT NOT NULL,
                     notes      TEXT NOT NULL DEFAULT '',
                     due_date   TEXT,
                     due_time   TEXT,
                     priority   INTEGER NOT NULL DEFAULT 0,
                     done       INTEGER NOT NULL DEFAULT 0,
                     created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
                 );
                 CREATE INDEX IF NOT EXISTS tasks_due_date ON tasks (due_date);
                 CREATE TABLE IF NOT EXISTS notifications (
                     id         INTEGER PRIMARY KEY AUTOINCREMENT,
                     app        TEXT NOT NULL,
                     summary    TEXT NOT NULL,
                     body       TEXT NOT NULL DEFAULT '',
                     created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
                 );",
            )
            .map_err(|error| error.to_string())?;
        // Bancos criados antes do ícone não têm a coluna; o erro de coluna repetida é esperado.
        let _ = connection.execute("ALTER TABLE notifications ADD COLUMN icon TEXT", []);
        Ok(Self(Mutex::new(connection)))
    }

    pub(crate) fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.0.lock().map_err(|_| "database is unavailable".to_owned())
    }
}

const COLUMNS: &str = "id, title, notes, due_date, due_time, priority, done, created_at";

fn read_task(row: &Row) -> rusqlite::Result<Task> {
    Ok(Task {
        id: row.get(0)?,
        title: row.get(1)?,
        notes: row.get(2)?,
        due_date: row.get(3)?,
        due_time: row.get(4)?,
        priority: row.get(5)?,
        done: row.get::<_, i64>(6)? != 0,
        created_at: row.get(7)?,
    })
}

fn clean(value: Option<String>) -> Option<String> {
    value.map(|text| text.trim().to_owned()).filter(|text| !text.is_empty())
}

fn validate(input: &TaskInput) -> Result<(), String> {
    if input.title.trim().is_empty() {
        return Err("title is required".to_owned());
    }
    if input.title.chars().count() > 200 {
        return Err("title is too long".to_owned());
    }
    Ok(())
}

fn fetch(connection: &Connection, id: i64) -> Result<Task, String> {
    connection
        .query_row(&format!("SELECT {COLUMNS} FROM tasks WHERE id = ?1"), [id], read_task)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_tasks(db: State<Database>) -> Result<Vec<Task>, String> {
    let connection = db.lock()?;
    let mut statement = connection
        .prepare(&format!(
            "SELECT {COLUMNS} FROM tasks
             ORDER BY done, due_date IS NULL, due_date, due_time IS NULL, due_time, priority DESC, id"
        ))
        .map_err(|error| error.to_string())?;
    let tasks = statement
        .query_map([], read_task)
        .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        .map_err(|error| error.to_string())?;
    Ok(tasks)
}

#[tauri::command]
pub fn create_task(db: State<Database>, input: TaskInput) -> Result<Task, String> {
    validate(&input)?;
    let connection = db.lock()?;
    connection
        .execute(
            "INSERT INTO tasks (title, notes, due_date, due_time, priority) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                input.title.trim(),
                input.notes.unwrap_or_default().trim(),
                clean(input.due_date),
                clean(input.due_time),
                input.priority.unwrap_or(0).clamp(0, 2),
            ],
        )
        .map_err(|error| error.to_string())?;
    fetch(&connection, connection.last_insert_rowid())
}

#[tauri::command]
pub fn update_task(db: State<Database>, id: i64, input: TaskInput) -> Result<Task, String> {
    validate(&input)?;
    let connection = db.lock()?;
    connection
        .execute(
            "UPDATE tasks SET title = ?1, notes = ?2, due_date = ?3, due_time = ?4, priority = ?5 WHERE id = ?6",
            params![
                input.title.trim(),
                input.notes.unwrap_or_default().trim(),
                clean(input.due_date),
                clean(input.due_time),
                input.priority.unwrap_or(0).clamp(0, 2),
                id,
            ],
        )
        .map_err(|error| error.to_string())?;
    fetch(&connection, id)
}

#[tauri::command]
pub fn set_task_done(db: State<Database>, id: i64, done: bool) -> Result<Task, String> {
    let connection = db.lock()?;
    connection
        .execute("UPDATE tasks SET done = ?1 WHERE id = ?2", params![done as i64, id])
        .map_err(|error| error.to_string())?;
    fetch(&connection, id)
}

#[tauri::command]
pub fn delete_task(db: State<Database>, id: i64) -> Result<(), String> {
    db.lock()?
        .execute("DELETE FROM tasks WHERE id = ?1", [id])
        .map_err(|error| error.to_string())?;
    Ok(())
}
