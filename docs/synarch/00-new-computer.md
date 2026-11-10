# 在另一台电脑上接着开发

两台电脑共用一个 GitHub 私有仓库。每次换电脑：**先拉取（pull），干完活提交并推送（push）**，另一台电脑才能拿到最新进度。

## 第一次在新电脑上准备（只做一次）

> 国内直连 GitHub 和 npm 很慢、还会断。下载前先在代理软件里打开「虚拟网卡（TUN）」，下面的步骤就都会走代理（完整下载仓库约 4 分钟，准备脚本约 4 分钟）。中途报网络错误，重新运行那一步即可。

1. 安装这几样（已经装了就跳过）：
   - Git：https://git-scm.com/download/win
   - Node.js 24 或更新版本：https://nodejs.org （选 LTS 或 Current，版本号 24 以上）
   - GitHub 命令行：https://cli.github.com
   - Claude 桌面版（用来让 Claude 帮你开发）
2. 打开 PowerShell，登录 GitHub（会打开浏览器让你确认）：

   ```powershell
   gh auth login
   ```

3. 把仓库下载到想放的位置，比如 D 盘：

   ```powershell
   cd D:\
   gh repo clone heimixieb/SYNARCH "SYNARCH — Super-agent System"
   ```

4. 运行一键准备脚本。它会安装项目依赖和 DeepSeek 工具，问你要 DeepSeek 密钥并存到这台电脑的私密位置（不会进仓库），最后做一次检查：

   ```powershell
   cd "D:\SYNARCH — Super-agent System"
   powershell -ExecutionPolicy Bypass -File scripts\synarch\setup-windows.ps1
   ```

   看到“准备完成”就可以了。
5. 在 Claude 桌面版里打开这个文件夹，说「继续任务」。Claude 会自动读项目根目录的 `CLAUDE.md`（你的习惯和开发经验）和 `docs/synarch/02-roadmap.md`（做到哪了）。

## 每次换电脑时

- 开始干活前，让 Claude “拉取最新代码”，或者自己运行：

  ```powershell
  git pull
  ```

  如果拉下来的改动里 `package.json` 或 `pnpm-lock.yaml` 变了，再运行一次 `pnpm install`。
- 离开这台电脑前，让 Claude “提交并推送”，或者自己运行：

  ```powershell
  git push
  ```

  没推送的改动，另一台电脑看不到。

## 注意

- 密钥只存在每台电脑自己的 `%USERPROFILE%\.synarch\deepseek.env` 里，不在仓库里。换了新密钥，两台电脑都要更新这个文件（重新运行准备脚本就行）。
- 你正在用的 OpenMausBot 正式版和这个开发项目互不影响。
