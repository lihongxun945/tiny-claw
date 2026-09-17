# 桌面客户端构建与发布

本文面向 tiny-claw 发布维护者。普通用户应从 GitHub Releases 下载 macOS DMG 或 Windows EXE 安装包。

## 本地构建

在 Apple Silicon Mac 上执行：

```bash
npm run desktop:dist
```

构建过程会依次编译 WebUI、主程序和 Electron 主进程，再通过 electron-builder 生成 arm64 DMG。安装包输出到：

```text
release/tiny-claw-<version>-arm64.dmg
```

如果登录钥匙串中存在有效的 `Developer ID Application` 证书及私钥，electron-builder 会自动签名应用；否则生成的包只能用于本地测试。

在 Windows x64 上执行（需要 Node.js 和 Git for Windows）：

```bash
npm ci
npm run desktop:dist:win
npm run desktop:smoke
```

输出 `release/tiny-claw-<version>-windows-x64-setup.exe`，NSIS 安装向导允许选择目录，默认按当前用户安装，卸载保留用户数据。不使用 Windows 签名证书，首次运行可能被系统安全策略拦截。不要用 macOS 交叉构建代替 Windows 原生构建和测试，因为 LanceDB 与 node-llama-cpp 含平台原生依赖。

`desktop:smoke` 检查打包后的原生模块、窗口启动/恢复和 Gateway 退出；Windows 可传安装目录 `npm run desktop:smoke -- "C:/测试目录"`。测试使用临时 userData，不读取真实用户配置；完整小模型推理另由 `npm run test:local-model` 验证。

## Tag 自动发布

`.github/workflows/desktop-release.yml` 监听 `v*` Tag。Tag 必须与 `package.json`、`package-lock.json` 中的版本完全一致，例如版本 `0.2.0` 对应 `v0.2.0`。

```bash
npm version patch
npm run test:all
git push origin HEAD --follow-tags
```

流水线会执行：

1. macOS 与 Windows 分别安装依赖、执行 `npm run test:all` 和内置 Qwen 模型冒烟测试。
2. macOS 导入 Developer ID Application 证书，构建签名 DMG、提交 Apple 公证并装订票据。
3. Windows 构建未签名的 x64 NSIS 安装包，进行静默安装、应用冒烟测试和卸载。
4. 验证打包后的窗口/Gateway 生命周期以及 LanceDB、llama 原生模块。
5. 生成平台独立的 SHA256 校验文件并上传 Actions Artifacts。
6. 两个平台均成功后，统一创建 GitHub Release；任一平台失败都不会发布不完整的版本，另一平台已上传的 Artifacts 仍可下载。

## GitHub Actions Secrets

macOS 构建需要配置以下 Secrets；Windows 构建不需要新增账号或签名 Secrets：

| Secret | 说明 |
|---|---|
| `MACOS_CERTIFICATE` | Developer ID Application `.p12` 的 Base64 内容 |
| `MACOS_CERTIFICATE_PASSWORD` | `.p12` 导出密码 |
| `APPLE_ID` | Apple Developer 账号 |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple ID App 专用密码 |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

证书在临时钥匙串中导入，任务结束后删除。公证轮询次数和间隔由工作流中的 `NOTARY_MAX_ATTEMPTS` 与 `NOTARY_POLL_INTERVAL_SECONDS` 控制。

## 发布产物

- `tiny-claw-<version>-arm64.dmg`
- `tiny-claw-<version>-arm64.dmg.blockmap`
- `tiny-claw-<version>-windows-x64-setup.exe`
- `SHA256SUMS-macos.txt`
- `SHA256SUMS-windows.txt`

macOS 用户数据位于 `~/Library/Application Support/tiny-claw/workspace`，Windows 通常位于 `%APPDATA%/tiny-claw/workspace`，覆盖安装不会删除这些目录。
