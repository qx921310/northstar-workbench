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

当前桌面版已可发现本机 Obsidian Vault 以及 DSH、Pi、Codex 的安装状态；待办会直接读写 Vault 中的 Markdown checkbox，笔记可创建、检索与跳转 Obsidian。GitHub 热点调用公开 API；“我的服务”读取 `~/.dsh/dsh-ssh.json` 中登记的主机，通过只读 SSH 采集 Hermes 与 Seoul 的基础健康度与关键服务状态。收件箱已支持 Gmail Desktop OAuth（PKCE）、Windows 凭据管理器令牌保存、收件箱列表与纯文本正文阅读；首次使用需在 Google Cloud 配置 Desktop app Client ID。Outlook、QQ 与通用 IMAP 目前保留账户登记入口，授权与同步仍在后续里程碑。

## 更新

Windows 应用启动后会检查本仓库 Releases 中的 `latest.json`。发现较新版本时，首页版本号旁显示更新入口；更新包必须通过应用内置公钥验证，才能安装。首次安装及手动下载请使用 Releases 中的 Windows 安装包。

发布更新时需要持有项目更新签名私钥。私钥和密码不得提交到仓库；构建时通过 `TAURI_SIGNING_PRIVATE_KEY` 与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 环境变量提供。发布包需同时上传安装程序、签名文件和包含版本、下载 URL 与签名内容的 `latest.json`。不要丢失私钥，否则已安装版本将无法验证以新密钥签名的更新。
