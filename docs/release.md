# macOS 构建与发布

本文面向 tiny-claw 发布维护者。普通用户应从 GitHub Releases 下载已构建的 DMG。

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

## Tag 自动发布

`.github/workflows/desktop-release.yml` 监听 `v*` Tag。Tag 必须与 `package.json` 中的版本完全一致，例如版本 `0.2.0` 对应 `v0.2.0`。

```bash
npm version patch
git push origin HEAD --follow-tags
```

流水线会执行：

1. 安装依赖并运行类型检查、测试和 WebUI E2E。
2. 运行内置 Qwen 模型冒烟测试。
3. 导入 Developer ID Application 证书。
4. 构建并签名 arm64 应用和 DMG。
5. 提交 Apple 公证并装订公证票据。
6. 校验签名和磁盘映像，生成 `SHA256SUMS.txt`。
7. 创建 GitHub Release 并上传 DMG、blockmap 和校验文件。

## GitHub Actions Secrets

仓库需要配置以下 Secrets：

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
- `SHA256SUMS.txt`

桌面应用的用户数据位于 `~/Library/Application Support/tiny-claw/workspace`，覆盖安装不会删除该目录。
