# Northstar Workbench

个人本机工作台的 Windows 桌面应用。当前包含：状态化首页、GitHub 热点、Agent 发现、Obsidian 待办/笔记，以及基于 DSH SSH 登记的服务健康查看。

## Run

```powershell
npm install
npm run dev
```

## Windows desktop app

```powershell
# 开发模式：启动 Tauri 窗口并热更新前端
npm run desktop:dev

# 生成 NSIS Windows 安装包
npm run desktop:build
```

构建产物位于 `src-tauri/target/release/bundle/nsis/`。

## 开发版与生产版

生产版从 GitHub Releases 安装，使用正式 Vault 和生产配置。`npm run desktop:dev` 启动明确标记为“开发版”的独立应用；`npm run desktop:build:dev` 可单独打包开发版，产物放在 `src-tauri/target-development/`，不会覆盖生产构建。

开发版使用 `%APPDATA%\Northstar Workbench Dev\TestVault` 作为空的测试 Vault，邮箱与自定义服务配置保存在同一个 Dev 目录，Gmail 凭据也使用独立的 Windows 凭据名称。开发版不读取正式 DSH 服务器登记、不打开正式 Obsidian Vault、不检查生产更新。若要验证邮箱或自定义服务，需要在开发版单独连接；手动连接的真实外部账户或服务依然是真实的，请使用测试账户和测试服务。Agent 安装探测为只读，会显示本机已安装的 Agent。

开发版首次运行只创建空的测试目录，不复制生产数据。开发模式必须使用以上命令，应用会在标识与编译环境不匹配时拒绝启动，以避免误用正式数据。

当前桌面版已可发现本机 Obsidian Vault 以及 DSH、Pi、Codex 的安装状态；待办会直接读写 Vault 中的 Markdown checkbox，笔记可创建、检索与跳转 Obsidian。GitHub 热点调用公开 API；“我的服务”读取 `~/.dsh/dsh-ssh.json` 中登记的主机，通过只读 SSH 采集 Hermes 与 Seoul 的基础健康度与关键服务状态。收件箱已支持 Gmail 应用专用密码和 Desktop OAuth（PKCE），凭据保存在 Windows 凭据管理器，支持列表与纯文本正文阅读；OAuth 模式需要 Google Cloud Desktop app Client ID。Outlook、QQ 与通用 IMAP 暂未接入授权和同步。

Gmail 也可使用应用专用密码通过 IMAP 连接。最近 20 封的列表元数据缓存在应用本机存储中，正文和邮箱凭据不写入列表缓存。再次进入时先显示缓存并后台核对；IMAP 仅对新出现的邮件获取邮件头，同时更新已读状态及移除已删除邮件。OAuth 当前仍以完整列表查询为主。缓存是本机数据，不会提交到项目仓库。

## 更新

Windows 应用分别检查原生更新和界面更新。原生更新使用 Releases 中的 `latest.json` 和签名安装包，需要退出并重启应用；界面更新使用对应桌面壳版本的 `ui-v<版本>` 预发布版，验证签名和版本兼容性后只刷新界面，窗口不退出。界面更新可能清除未保存的输入，因此应用前需要用户确认。新界面启动未确认时自动回退；已确认的更新包会在每次启动时重新验证签名。桌面壳更新后，旧壳的界面补丁不会应用到新壳。

发布更新时需要持有项目更新签名私钥。私钥和密码不得提交到仓库；构建时通过 `TAURI_SIGNING_PRIVATE_KEY` 与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 环境变量提供。发布包需同时上传安装程序、签名文件和包含版本、下载 URL 与签名内容的 `latest.json`。不要丢失私钥，否则已安装版本将无法验证以新密钥签名的更新。

仅修改前端且兼容当前桌面壳时，可以发布界面更新。先提交并推送修改，在提供签名密钥的环境下执行：

```powershell
./scripts/build-ui-update.ps1 -Revision 1
# 可选：使用内置公钥验证生成的签名及当前桌面壳版本
$env:NORTHSTAR_UI_BUNDLE_TEST = (Resolve-Path 'src-tauri/target/ui-release/ui-1.zip').Path
Push-Location src-tauri; cargo test ui_updates::tests::locally_built_release_bundle_verifies_when_requested; Pop-Location
./scripts/publish-ui-update.ps1 -Revision 1
```

同一桌面壳的修订号必须递增。发布脚本会将包和签名上传到 `ui-v<版本>` 预发布版；该预发布版不替代正式安装包的 `latest`。需要新增或修改 Rust 命令、权限、依赖或其他原生能力时，必须发布新的桌面壳及签名安装包，不能只发布界面包。仅发布完整安装包不会自动生成界面更新。
