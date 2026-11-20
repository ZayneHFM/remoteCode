# remoteCode

从手机或平板查看并接续 Windows 电脑上的 Codex 会话。

remoteCode 在电脑本地运行。移动端网页和可选的 Android 应用通过 **Tailscale Serve** 访问面板，首次连接时用电脑窗口显示的配对码配对。[Tailscale Serve 文档](https://tailscale.com/docs/features/tailscale-serve)

## 使用

1. 在 Windows 电脑安装 Node.js，并在 Codex 桌面端或 CLI 登录。本项目用 Node.js 24 验证。程序会查找本机 Codex，也可以通过环境变量 `REMOTE_CODEX_EXE` 指定 Codex 可执行文件。
2. 在电脑和手机上安装 Tailscale，让两台设备加入同一个 tailnet。为 tailnet 启用 MagicDNS 和 HTTPS 证书。
3. 在项目目录启动电脑端。

   ```powershell
   powershell.exe -NoProfile -STA -File .\desktop-panel.ps1
   ```

4. 在 remoteCode 窗口点击「连接手机」完成设置，再用手机浏览器打开显示的 HTTPS 地址。点「连接新设备」查看配对码。电脑上的「打开面板」也可以进入网页。

面板监听 `127.0.0.1:8788`。Tailscale Serve 在 tailnet 内通过 HTTPS 将请求转到这个地址。默认 HTTPS 端口是 `8443`。也可以在电脑上手动配置。

```powershell
tailscale serve --bg --https=8443 http://127.0.0.1:8788
```

配对设备可以发起受电脑端权限约束的 Codex 操作。请把配对码和面板访问权交给有权操作这台电脑的设备。

## 当前功能

- 按工作域查找电脑上的会话，查看历史和实时进度，在原会话中继续发送。
- 查看当前目标和待处理队列，将尚未执行的消息移到队首。电脑正在持有会话时，队列按电脑端设置处理。
- 在面板能直接接收的 Codex 任务里审批和答复提问。
- 使用手机或平板的浏览器打开面板，也可以使用 Android 应用。Harness 入口未实现。

## 构建 Android 应用

在 Windows 上准备 JDK 17 或更新版本，以及 Android SDK Platform 35 和 Android SDK Build-Tools。设置 `JAVA_HOME`、`ANDROID_HOME`，或使用脚本的 `-JavaHome`、`-AndroidSdkRoot` 参数。

```powershell
powershell.exe -NoProfile -File .\android\build.ps1
```

默认输出 `安装包/PersonalRemotePanel.apk`。应用首次打开时输入电脑窗口显示的 Tailscale HTTPS 地址。脚本会在当前 Windows 用户目录生成本地签名材料，后续覆盖升级请使用同一个签名。只使用手机浏览器时可跳过这一步。

## 开发与测试

```powershell
node tests/queue-fallback.test.mjs
```

本地配对、运行记录、构建缓存和签名材料由各自的电脑保存。项目使用 [MIT 许可证](LICENSE)。
