use super::{app_data_dir, vault_path};
use fs2::FileExt;
use rand::distr::{Alphanumeric, SampleString};
use serde::{Deserialize, Serialize};
use std::{fs, io::{Read,Seek,SeekFrom,Write}, path::{Path,PathBuf}, sync::{Mutex,OnceLock}};

static NOTE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub(super) struct LocalNote { id:String, title:String, body:String, revision:u64, pushed_body:Option<String> }
fn valid_id(id:&str)->bool { id.len()==24 && id.chars().all(|c| c.is_ascii_alphanumeric()) }
fn atomic_write(path:&Path, data:&[u8])->Result<(),String> {
    let parent=path.parent().ok_or("路径无效")?; fs::create_dir_all(parent).map_err(|_|"无法创建笔记目录")?;
    let mut temp=tempfile::NamedTempFile::new_in(parent).map_err(|_|"无法保存笔记")?;
    temp.write_all(data).and_then(|_|temp.as_file().sync_all()).map_err(|_|"无法保存笔记")?;
    temp.persist(path).map_err(|e|format!("无法替换笔记文件：{}",e.error))?; Ok(())
}
fn load(dir:&Path,id:&str)->Result<LocalNote,String> { if !valid_id(id) {return Err("笔记标识无效".into())} let data=fs::read(dir.join(format!("{id}.json"))).map_err(|_|"笔记不存在")?; serde_json::from_slice(&data).map_err(|_|"本地笔记损坏".into()) }
fn store(dir:&Path,note:&LocalNote)->Result<(),String> { let bytes=serde_json::to_vec(note).map_err(|_|"无法编码笔记")?; atomic_write(&dir.join(format!("{}.json",note.id)),&bytes) }
fn directory()->PathBuf {app_data_dir().join("local-notes")}
fn lock_local_notes()->Result<fs::File,String> { let dir=directory(); fs::create_dir_all(&dir).map_err(|_|"无法创建笔记目录")?; let lock=fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(dir.join(".notes.lock")).map_err(|_|"无法锁定本地笔记")?; lock.lock_exclusive().map_err(|_|"本地笔记正在使用")?; Ok(lock) }
#[tauri::command]
pub(super) fn list_local_notes()->Result<Vec<LocalNote>,String> {
 let _guard=NOTE_LOCK.get_or_init(Default::default).lock().map_err(|_|"本地笔记不可用")?; let _file_guard=lock_local_notes()?; let dir=directory(); if !dir.exists(){return Ok(vec![])}
 let mut notes=Vec::new(); for entry in fs::read_dir(&dir).map_err(|_|"无法读取本地笔记")? { let entry=entry.map_err(|_|"无法读取本地笔记")?; let path=entry.path(); if path.extension().and_then(|v|v.to_str()) != Some("json") {continue} let id=path.file_stem().and_then(|v|v.to_str()).unwrap_or(""); notes.push(load(&dir,id)?); } notes.sort_by(|a,b|a.title.cmp(&b.title)); Ok(notes)
}
#[tauri::command]
pub(super) fn save_local_note(id:Option<String>,title:String,body:String,expected_revision:Option<u64>)->Result<LocalNote,String> {
 let _guard=NOTE_LOCK.get_or_init(Default::default).lock().map_err(|_|"本地笔记不可用")?; let _file_guard=lock_local_notes()?; let dir=directory(); let title=title.trim().to_string(); if title.is_empty() || title.len()>300 || body.len()>5_000_000 {return Err("请填写标题，正文不能超过 5 MB".into())}
 let mut note=if let Some(id)=id { let n=load(&dir,&id)?; if Some(n.revision)!=expected_revision {return Err("本地笔记已在其他窗口发生变化，请重新打开后再保存".into())} n } else { LocalNote{id:Alphanumeric.sample_string(&mut rand::rng(),24),title:String::new(),body:String::new(),revision:0,pushed_body:None} };
 note.title=title; note.body=body; note.revision+=1; store(&dir,&note)?; Ok(note)
}
#[tauri::command]
pub(super) fn delete_local_note(id:String,expected_revision:u64)->Result<(),String> {let _guard=NOTE_LOCK.get_or_init(Default::default).lock().map_err(|_|"本地笔记不可用")?;let _file_guard=lock_local_notes()?;let dir=directory();let note=load(&dir,&id)?;if note.revision!=expected_revision{return Err("本地笔记已发生变化，请重新打开后再删除".into())}fs::remove_file(dir.join(format!("{id}.json"))).map_err(|_|"无法删除本地笔记".into())}
fn push_at(dir:&Path,vault:&Path,id:&str,expected_revision:u64)->Result<LocalNote,String> {
 let mut note=load(dir,id)?; if note.revision!=expected_revision {return Err("本地笔记已改变，请重新打开后再同步".into())}
 let root=vault.canonicalize().map_err(|_|"无法访问 Obsidian Vault")?; let folder=root.join("Northstar"); fs::create_dir_all(&folder).map_err(|_|"无法创建同步目录")?; let folder=folder.canonicalize().map_err(|_|"无法访问同步目录")?; if !folder.starts_with(&root) {return Err("同步目录不在 Vault 内".into())}
 let target=folder.join(format!("{id}.md")); let content=format!("# {}\n\n{}",note.title,note.body);
 if target.exists() {
  if target.is_symlink() || !target.canonicalize().is_ok_and(|p|p.starts_with(&folder)) {return Err("同步目标不安全".into())}
  let mut options=fs::OpenOptions::new(); options.read(true).write(true);
  #[cfg(windows)] { use std::os::windows::fs::OpenOptionsExt; options.share_mode(5); }
  let mut guard=options.open(&target).map_err(|_|"Obsidian 笔记正在使用，请稍后重试")?;
  let mut remote=String::new();guard.read_to_string(&mut remote).map_err(|_|"无法读取 Obsidian 笔记")?;
  if remote!=content && note.pushed_body.as_deref()!=Some(remote.as_str()) {return Err("Obsidian 中的笔记已被修改，已停止同步以避免覆盖，请先手动核对".into())}
  if remote!=content { let backup=dir.join("backups").join(format!("{}-{}.md",id,note.revision)); if !backup.exists() {atomic_write(&backup,remote.as_bytes())?;}
   let write_result=guard.seek(SeekFrom::Start(0)).and_then(|_|guard.set_len(0)).and_then(|_|guard.write_all(content.as_bytes())).and_then(|_|guard.sync_all());
   if write_result.is_err() { let _=guard.seek(SeekFrom::Start(0)); let _=guard.set_len(0); let _=guard.write_all(remote.as_bytes()); let _=guard.sync_all(); return Err("同步写入失败，已尝试恢复原文件；备份保存在工作台数据目录".into()); } }
  drop(guard);
 } else {
  if note.pushed_body.is_some() { return Err("Obsidian 中的已同步笔记已被删除，已停止同步，请先手动核对".into()); }
  let mut temp=tempfile::NamedTempFile::new_in(&folder).map_err(|_|"无法创建同步文件")?;
  temp.write_all(content.as_bytes()).and_then(|_|temp.as_file().sync_all()).map_err(|_|"无法保存同步文件")?;
  temp.persist_noclobber(&target).map_err(|_|"同步目标已出现或无法写入，请重试")?;
 }
 note.pushed_body=Some(content); note.revision+=1; store(dir,&note)?; Ok(note)
}
#[tauri::command]
pub(super) fn push_local_note(id:String,expected_revision:u64)->Result<LocalNote,String> {let _guard=NOTE_LOCK.get_or_init(Default::default).lock().map_err(|_|"本地笔记不可用")?;let _file_guard=lock_local_notes()?;push_at(&directory(),&vault_path(),&id,expected_revision)}
#[cfg(test)] mod roundtrip_tests { use super::*; #[test] fn second_push_updates_unchanged_target_and_keeps_backup() {let t=tempfile::tempdir().unwrap();let dir=t.path().join("local");let vault=t.path().join("vault");fs::create_dir_all(&vault).unwrap();let n=LocalNote{id:"abcdefghijklmnopqrstuvwx".into(),title:"title".into(),body:"first".into(),revision:1,pushed_body:None};store(&dir,&n).unwrap();let mut n=push_at(&dir,&vault,&n.id,1).unwrap();n.body="second".into();n.revision+=1;store(&dir,&n).unwrap();let n=push_at(&dir,&vault,&n.id,n.revision).unwrap();assert_eq!(fs::read_to_string(vault.join("Northstar").join(format!("{}.md",n.id))).unwrap(),"# title\n\nsecond");assert!(dir.join("backups").exists());} }
#[cfg(test)] mod tests { use super::*; #[test] fn push_detects_remote_changes_without_overwriting() {let temp=tempfile::tempdir().unwrap(); let dir=temp.path().join("local"); let vault=temp.path().join("vault");fs::create_dir_all(&vault).unwrap();let note=LocalNote{id:"abcdefghijklmnopqrstuvwx".into(),title:"title".into(),body:"one".into(),revision:1,pushed_body:None};store(&dir,&note).unwrap();let n=push_at(&dir,&vault,&note.id,1).unwrap(); let target=vault.join("Northstar").join(format!("{}.md",note.id));fs::write(&target,"external edit").unwrap();let mut changed=n.clone();changed.body="two".into();changed.revision+=1;store(&dir,&changed).unwrap();assert!(push_at(&dir,&vault,&note.id,changed.revision).is_err());assert_eq!(fs::read_to_string(target).unwrap(),"external edit");} }


#[cfg(test)] mod deletion_conflict_tests { use super::*; #[test] fn externally_deleted_note_is_not_silently_recreated() {let t=tempfile::tempdir().unwrap();let dir=t.path().join("local");let vault=t.path().join("vault");fs::create_dir_all(&vault).unwrap();let n=LocalNote{id:"abcdefghijklmnopqrstuvwx".into(),title:"title".into(),body:"content".into(),revision:1,pushed_body:None};store(&dir,&n).unwrap();let n=push_at(&dir,&vault,&n.id,1).unwrap();let target=vault.join("Northstar").join(format!("{}.md",n.id));fs::remove_file(&target).unwrap();assert!(push_at(&dir,&vault,&n.id,n.revision).is_err());assert!(!target.exists());} }
