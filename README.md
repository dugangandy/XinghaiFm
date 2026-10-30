# 星海 FM · 本地有声书播放器

把本地文件夹变成私人音频图书馆：自动整理成专辑、自由分类、倍速播放、全离线。深空霓虹风格界面，音频只留在本机，无任何联网请求。

## 三种打开方式

| 方式 | 适用 | 说明 |
| --- | --- | --- |
| **桌面版 exe（推荐）** | Windows / macOS | 双击安装版或便携版 exe；首次选一次目录，之后自动记住并同步 |
| **启动.bat** | 浏览器 | 起本地服务器（localhost:8080），浏览器打开，可记住目录授权 |
| **双击 index.html** | 临时用 | 以 file:// 打开，功能齐全，但每次重开要重新选目录 |

### 桌面版

1. 双击 `dist/星海FM-<版本>-Setup.exe`（安装版）或 `dist/星海FM-<版本>.exe`（便携版）
2. 点左上角「选择资源库」，选到有声书所在文件夹
3. 扫描完成后即可使用；下次启动自动恢复资源库与上次播放位置

- 库列表记在 `%APPDATA%\星海FM\fm.db`（SQLite）
- 分类、收藏、播放进度记在该目录下的 LocalStorage
- 未做代码签名，首次运行若出现 SmartScreen 提示，点「更多信息 → 仍要运行」

## 功能

- **资源库**：一个目录一个库，可加多个（有声书 / 课程 / 广播剧…），侧栏一键切换
- **目录即专辑**：每个顶层子目录自动成为专辑，按集号自然排序（第 2 集在第 10 集之前）
- **专辑封面**：`node tools/fetch-covers.js` 按目录名搜同名专辑下载封面到 `.fm-covers/`，搜不到才退回渐变封面
- **自动去重**：同名文件只保留体积最大的一个
- **智能分类**：首次扫描按关键词归入历史军事 / 文学小说 / 心理成长 / 国学经典 / 影视原声，可增删改
- **分类管理**：新建、换色、重命名、删除；专辑卡片可直接拖到左侧分类，一个专辑可属多个分类
- **收藏 / 置顶 / 隐藏 / 重命名**：卡片或详情页的「更多」菜单
- **继续收听 / 最近播放 / 已听完**：每集播放位置自动记录，最多 4 秒落盘
- **播放器**：0.5×–3× 倍速（保持音调）、进度拖动、上下集、列表 / 单集 / 随机 / 顺序、定时关闭、音量
- **全屏播放页**：实时频谱、大封面、15 秒快进快退、播放队列
- **视频播放**：mp4 / webm 直接看，B 站式画面 + 浮层控件
- **系统媒体键**：支持键盘媒体键与锁屏信息
- **离线**：无外链、无字体 CDN、无埋点

## 资源库

一个资源库 = 一个目录。想放两类内容就加两个库。

- **切换**：点侧栏最上面那块（当前库名）→ 选一个。有缓存的库秒开，同时后台补扫新文件
- **管理**：同菜单里的「资源库设置…」，或空库时的「添加资源库」按钮
  - 添加：选文件夹，加进列表并立即扫描
  - 重命名：只改显示名，不动路径
  - 重新定位：目录改名 / 换盘时用，分类收藏不丢
  - 在文件夹中打开：弹出系统文件管理器
  - 移除：只移除列表项，文件夹、分类、收藏都留在本机
- **分类和收藏按库隔离**；**播放进度按相对路径全局共享**，同一本书放两个库也只记一份
- **切库会停止播放**：进度已落盘，切回来续播即可
- **目录不见了**（改名 / 移动 / 移动硬盘没插）：侧栏标红，首页给出「重新定位 / 切换资源库」

分类、收藏、播放进度除浏览器存储外，还会同步一份到库目录下的 `.fm-meta.json`。

## 视频

视频与音频共用同一资源库和播放链路：扫描时按扩展名识别，列表行带「视频」角标，专辑卡片显示视频集数；点开视频集自动进播放页视频模式。

**支持格式**：`mp4 / m4v / mov / webm / ogv`。`mkv / avi / flv / rmvb` 跳过，需要时先换容器：

```bash
ffmpeg -i 某剧集.mkv -c copy 某剧集.mp4     # 只换容器，几秒钟
```

**播放页操作**

| 操作 | 行为 |
| --- | --- |
| 单击画面 | 播放 / 暂停（暂停时中央有大播放键） |
| 双击画面 | 影院模式开 / 关 |
| 鼠标静止约 2.6 秒 | 顶部信息与底部控件淡出、光标隐藏 |
| 底部进度条 | 悬停看时间点、可拖动，已缓冲部分高亮 |
| 选集 | 右侧滑出集数列表，点一条直接切 |
| 画中画 / 影院 / 全屏 | 右下角三个按钮 |
| 切回音频集 | 画面收起，封面 + 频谱照旧 |

倍速、音量、静音、定时关闭、断点续播在视频里同样生效。

## 专辑封面

封面由脚本先抓到本地，播放器只读本地文件，界面无外链请求。

```bash
node tools/fetch-covers.js                       # 默认抓 E:\迅雷下载\output
node tools/fetch-covers.js --root "D:/有声书"     # 换目录
node tools/fetch-covers.js --only 三体            # 只补某几本
node tools/fetch-covers.js --force               # 全部重抓
```

- 结果放在音频目录的 `.fm-covers/`：图片 + `covers.json`（目录名 → 图片、匹配到的专辑标题、相似度）
- 已抓过的自动跳过，新加几本书再跑一次即可
- 播放器按目录名精确匹配，再按相似度（≥0.8）复用

### 手工指定封面：`.fm-covers/manual.json`

搜不到或匹配错时，把「目录名 → 专辑页」写进去再跑一次脚本：

```json
{
  "抗美援朝战争全史": "https://www.ximalaya.com/album/39246532",
  "三体 有声书全本无删减 王明军单播 刘慈欣原著": "40121646",
  "某张只能找到图的书": "https://imagev2.xmcdn.com/group82/M01/06/3C/wKg5Il70GkGy2c7HAAHU2k3a36c730.jpg"
}
```

- **专辑页地址 / 纯数字 id**：走 `/revision/album/v1/simple?albumId=<id>` 取封面与标题，写死的 id 不做相似度拦截
- **图片地址**：直接下载，自动去掉 `!magick=webp` 等参数并补 600×600
- 键必须与专辑目录名完全一致（脚本输出里会打印），`--force` 时同样生效

## 快捷键

| 按键 | 作用 |
| --- | --- |
| 空格 | 播放 / 暂停 |
| ← / → | 后退 / 前进 15 秒 |
| Shift + ← / → | 上一集 / 下一集 |
| ↑ / ↓ | 音量 ±5% |
| [ / ] | 降低 / 提高倍速 |
| M | 静音 |
| F | 展开 / 收起全屏播放页 |
| N / P | 下一集 / 上一集 |
| / | 聚焦搜索框 |
| Esc | 先退影院模式，再收起播放页 / 关闭菜单 |

## 目录结构

```
fm/
├─ index.html          页面骨架（图标精灵、侧栏、播放条、播放页）
├─ css/                base / layout / components
├─ js/                 util · store · media · fs · covers · library · viz · player · ui · app
├─ tools/              fetch-covers.js · serve.js · tunnel.js · bump-version.js
├─ main.js             Electron 主进程（选目录、扫描、读文件、自定义协议）
├─ preload.js          暴露给页面的原生能力
├─ build/              应用图标与启动图
├─ dist/               打包产物
├─ 启动.bat            浏览器模式的本地服务器
├─ 启动-公网.bat        服务器模式 + SSH 反向隧道（读 .tunnel.json）
└─ README.md
```

## 开发与打包

```bash
npm install            # 安装 electron / electron-builder
npm start              # 启动桌面版（开发模式）
npm run dist           # Windows：便携版 exe + 安装版 Setup exe
npm run dist:mac       # macOS：dmg + zip（arm64 / x64），需在 Mac 上跑
```

**版本号手动维护**：打包不会自动改版本号，需要发版时手动执行 `npm run bump`（小版本号 +1 并同步 `package-lock.json`），产物名跟着 `package.json` 的 version 走。逻辑在 `tools/bump-version.js`。

**两种 Windows 产物**：

- `星海FM-<版本>-Setup.exe`：安装版，装到 `%LOCALAPPDATA%\Programs`，桌面 / 开始菜单有快捷方式，启动约 3 秒
- `星海FM-<版本>.exe`：便携单文件，免安装，每次启动要解包 ~360 MB 到临时目录，约 10 秒。适合临时试听

### macOS

- **源码包**：`dist/XinghaiFM-<版本>-src.zip`，解压后 `npm install && npm start`
- **出安装包**：解压后双击 `打包-macOS.command`，或 `npm run dist:mac` → `dist/` 里的 dmg / zip
- **公网隧道**：双击 `启动-公网.bat`，先 `node tools/init-db.js` 初始化用户 / 密码
- 已配好图标 `build/icon.icns`、分类 `public.app-category.music`、应用菜单、最低系统 macOS 12.7.6
- 无开发者证书时走 ad-hoc 签名，首次打开需「右键 → 打开」

### 前端运行通道

桌面版与网页版共用同一套前端，区别只在 `js/fs.js` 取文件的方式：

| 运行环境 | 通道 |
| --- | --- |
| Electron | `fmNative` 原生对话框选目录 → 主进程扫描 → `fm://app/__media/…` 按 Range 流式播放 |
| localhost / https | File System Access API，目录句柄存 IndexedDB，刷新免重选 |
| file:// | `<input webkitdirectory>`，每次需重选目录 |

## 远程访问（可选）

用「服务器模式 + SSH 反向隧道」让手机或别的电脑听这台机器上的书，音频由 `tools/serve.js` 托管，支持 Range 拖动。

1. **初始化数据库**（首次会自动把旧 `.auth.json`/`config.json` 迁移为 `admin` 用户）：

   ```bash
   node tools/init-db.js                        # 迁移旧配置 / 生成 admin
   node tools/init-db.js --add-user 用户名       # 再加一个用户
   node tools/init-db.js --set-password admin    # 改密码
   ```

   用户与密码存在 `fm.db`（pbkdf2-sha256 60 万轮哈希），每个用户各自独立的资源库。改密码会立即让**该用户**已登录的设备失效（其它用户不受影响）。

2. **只在本机试**：

   ```bash
   node tools/serve.js 8080
   ```

   打开 `http://127.0.0.1:8080/`，用用户名 + 密码登录后进资源库。

3. **挂到公网**：把 `.tunnel.example.json` 复制成 `.tunnel.json`，填 `ssh.host`（`ssh.key` 留空用 `~/.ssh/id_rsa`），双击 `启动-公网.bat`：

   ```
   清理服务器上残留的 8889 监听…
   访问地址  http://<你的服务器地址>:8889/
   ```

   启动前会 `ssh root@host "fuser -k 8889/tcp"` 清掉上次残留监听。

4. **服务器侧前置条件**（脚本改不了）：
   - `/etc/ssh/sshd_config` 里 `GatewayPorts clientspecified`，否则 8889 只绑在 127.0.0.1
   - 云安全组放行 8889

登录后种 HMAC 签名会话 Cookie（HttpOnly / SameSite=Lax），7 天不用失效、最多续到 30 天；同一 IP 10 分钟内错 5 次锁 10 分钟。

### 远程同步

桌面端把整理结果写进库目录的 `.fm-meta.json`，服务端直接读这份文件：

| 数据 | 方向 |
| --- | --- |
| 分类定义、分类归属、收藏、专辑改名 | 桌面 → 远程（远程只读） |
| 时长 | 桌面 → 远程 |
| 播放进度 | 桌面 ⇄ 远程，逐条按时间戳取新的 |

- 桌面端有改动约 5 秒写一次；手机播放每 10 秒推一次进度（暂停 / 切集 / 关页面立即推）
- 桌面启动、窗口重新获得焦点时，把文件里更新的进度合并回本地
- 远程可切换资源库：服务端通过 `/api/libs` + `/api/activate` 暴露
- `.tunnel.json` 的 `configFile` 已弃用（库列表改从 `fm.db` 读）
- **断线重连**：3 → 6 → 9 秒…（封顶 30 秒），稳定 20 秒后重新计时；连续两次「刚连上就断」会先清残留监听，`Ctrl+C` 手动退出
- **重连上限**：`maxRetries`（默认 10，0 = 不限），临时改可用 `node tools/tunnel.js --max-retries 3`

**安全开关**

- 远程增删资源库默认关闭，需 `--allow-lib-edit`（隧道模式在 `.tunnel.json` 写 `"allowLibEdit": true`）
- 即使开启也不能把磁盘根目录加成资源库
- `/api/media` 只放行媒体扩展名，其它文件 404
- 远程增删库会在服务端控制台打日志

### 桌面客户端直连远程

界面仍是本机的（秒开），书和音频留在服务器上。

1. 服务器起服务：`node tools/serve.js 8080`
2. 桌面端侧栏「资源库」→ **连接远程服务器…** → 填地址 `http://192.168.1.8:8080`（不带末尾斜杠）+ 用户名 / 密码 → 连接，界面自动重载
3. 断开：同一入口变成 **远程服务器设置…**，点「断开连接」

- 远程地址与 token 存进 `fm.db` 的 `remote` 表，内容 `{ base, token }`；**token 等同该用户的长期登录凭证**
- token 走 `Authorization: Bearer`；`<audio>` / `<img>` 改用 `GET /api/ticket` 换 2 小时票据挂在 `?t=` 上
- 服务端已放开跨源，因为桌面页面来自 `fm://app`
- 远程模式下库列表只读
- 侧栏标「远程 · N 个资源库」，库徽标小圆点表示链路状态
- 服务器上没有桌面端时：在服务器上 `node tools/init-db.js` 建库并加用户，启动服务加 `--allow-lib-edit`，用浏览器登录后在「资源库设置」里填目录路径

- **明文 http 只建议局域网或 SSH 隧道**，走公网请套 https 反代
- 掉线后顶栏显示「离线，正在重连…」，按 3 → 6 → 9 → 15 → 30 秒退避；token 失效变成「远程未授权，点此重连」

## 安卓 App（可选）

手机端不是独立播放器：它是一个装着本项目的壳，音频仍由电脑上的 `tools/serve.js` 提供。适合"书放在电脑里、手机当随身听"。

1. **电脑端起服务**（第一次先初始化数据库）：
   ```bash
   node tools/init-db.js
   node tools/serve.js 8080
   ```
   确认电脑防火墙放行 8080（或改用已配好的 SSH 隧道地址）。
2. **拿 APK**：仓库的 **Actions → Android APK → Run workflow**，跑完在产物里下载 `XinghaiFM-<版本>-debug.apk`（推送 `v*` 标签也会自动构建）。
3. **安装**：传到手机点开安装，首次需允许"安装未知应用"。
4. **首次打开**：填 `http://<电脑局域网 IP>:8080`（可省略 `http://`），点「连接」→ 在登录页输一次用户名 + 密码，之后一直记住。

- 换服务器 / 重新登录：侧栏「资源库」→「服务器地址…」，或资源库设置抽屉底部
- 手机上分类、收藏、改名是只读的（和浏览器远程访问一致）；播放进度每 10 秒回传，电脑端下次打开自动合并
- 后台与锁屏：播放时起前台服务 + MediaSession，通知栏和锁屏可播放/暂停/上下集；切后台、锁屏继续播
- 返回键：先关播放页 / 弹层 / 抽屉，再退页面，首页按两次退出
- 界面为手机重排过（底部播放条、全屏播放页、安全区、触控尺寸、特效降级），桌面端布局不受影响
- **明文 http 只建议局域网或 SSH 隧道**，走公网请套 https 反代；`usesCleartextTraffic` 开着是为了局域网直连
- 自己构建见 [`android/README.md`](android/README.md)

## 配置参考

### 文件位置

| 文件 | 位置 | 作用 | 能否删 |
| --- | --- | --- | --- |
| `fm.db` | `%APPDATA%\星海FM\`（macOS：`~/Library/Application Support/星海FM/`） | SQLite：用户 / 资源库 / 远程配置 | 删了要重新 `node tools/init-db.js`（音频不受影响） |
| `.fm-meta.json` | 每个资源库目录内 | 分类 / 收藏 / 改名 + 进度 / 时长 | 删了会重建，远程端暂时看不到分类 |
| `.fm-covers/covers.json` | 每个资源库目录内 | 封面索引 | 删了只是没封面 |
| `.tunnel.json` | 项目根目录 | 公网隧道配置 | 删了 `启动-公网.bat` 会提示缺配置 |

桌面版 LocalStorage 在 `%APPDATA%\星海FM\Local Storage\leveldb`，是分类 / 收藏 / 进度 / 索引缓存的主副本，不用手工改。

### `.tunnel.json`

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `ssh.host` | — | 服务器地址（必填） |
| `ssh.port` | `22` | SSH 端口 |
| `ssh.key` | `""` | 私钥路径，留空用 `~/.ssh/id_rsa` |
| `localPort` | `8080` | 本地服务端口 |
| `remotePort` | `8889` | 服务器对外端口 |
| `configFile` | 自动 | 旧版：指定另一份 `config.json` 作为迁移来源（已弃用） |
| `allowLibEdit` | `false` | 是否允许网页增删 / 重命名资源库 |
| `maxRetries` | `10` | 重连上限，0 = 不限 |

### 数据库 `fm.db`

- SQLite（`node:sqlite`），表：`users` / `libs`（按 `user_id`）/ `remote` / `settings`
- 桌面端固定使用 `admin` 用户的库；浏览器登录哪个用户，就只看到该用户的库与数据
- 老版本 `config.json` / `.auth.json` / `remote.json` 在首次运行 `init-db` 或启动桌面端时自动迁移，旧文件改名为 `*.migrated.bak`
- 服务端只有开了 `--allow-lib-edit` 才通过 `/api/lib` 修改当前用户的库

### `tools/serve.js` 参数

| 参数 | 说明 |
| --- | --- |
| `<port>` | 端口，默认 8080 |
| `--allow-lib-edit` | 允许远程增删资源库（默认关） |
| `--host <ip>` | 监听地址，默认 `127.0.0.1` |
| `--no-auth` | 免密（仍取第一个用户），仅本机调试 |
| `--add-user <name> [pw]` | 新增用户 |
| `--set-password <name> [pw]` | 修改某用户密码 |
| `--check-password <name> [pw]` | 校验某用户密码 |
| `--list-users` | 列出用户 |
| `--remove-user <name>` | 删除用户（连同其库） |

环境变量 `FM_DATA_FILE`：把数据库文件指到别处（默认 `%APPDATA%\星海FM\fm.db`），测试或多实例时用。

`启动-公网.bat` 自动拼 `<localPort> --host 127.0.0.1 [--config <file>]`，再按 `.tunnel.json` 决定是否加 `--allow-lib-edit`。

### `tools/tunnel.js` 参数

| 参数 | 说明 |
| --- | --- |
| `--max-retries <n>` | 临时覆盖 `.tunnel.json` 的重连上限（0 = 不限） |

### 服务端接口

都需要登录会话（`--no-auth` 除外）：

| 接口 | 说明 |
| --- | --- |
| `GET /api/config` | `{ server, rootName, multi, libEdit }` |
| `GET /api/libs` | 资源库列表 + 当前库 |
| `GET /api/activate?id=` | 切换当前库 |
| `GET /api/meta` | 当前库的 `.fm-meta.json` |
| `POST /api/progress` | 回传播放进度，按时间戳合并 |
| `POST /api/lib` | 增 / 删 / 改名资源库（需 `--allow-lib-edit`） |
| `POST /api/login` | 用户名+密码换长期 token，body `{ username, password }`，返回 `{ token, uid, username }` |
| `GET /api/me` | 当前用户 `{ uid, username, role }` |
| `GET /api/ticket` | 换 2 小时票据，给 `?t=` 用 |
| `GET /api/scan` | 目录列表 |
| `GET /api/media/<rel>` | 音频流（Range），只放行媒体扩展名 |
| `GET /api/covers` · `/api/cover/<file>` | 封面索引与图片 |

## 常见问题

**某集点了没声音？** 文件可能已移动或删除，点侧栏刷新重新扫描。

**想换一个文件夹？** 点侧栏顶部的资源库按钮切换，或在「资源库设置」里添加 / 重新定位。

**原来的单目录配置还能用吗？** 能。老的 `{ "root": "..." }` 首次启动自动升级成一条资源库，分类和收藏一起搬过去。

**视频只有声音？** 容器对了但编码不对（如 HEVC），换 H.264/AAC 的 mp4，或按上面的 ffmpeg 命令转一次。

**播放进度会丢吗？** 主副本在 LocalStorage，同时约每 5 秒落一份到库目录的 `.fm-meta.json`。分类 / 收藏的主副本是 LocalStorage，换电脑想全带走请备份整个 `%APPDATA%\星海FM\`。

**桌面端加了资源库，网页上没看到？** 服务端按 mtime 热加载，最多 1 秒生效；仍看不到就确认访问的是同一台机器上的服务（`/api/config` 的 `multi` 应为 `true`）。
