# xcode：两台 Windows 共享一个 PowerShell 工作区

在办公本的 PowerShell 输入 `xcode`，会打开主力机上同一个、可长期保留的 WezTerm 工作区。标签页、分屏和其中的 PowerShell 7 进程都实际运行在主力机上；办公本只是另一个图形前端。

```text
主力机 WezTerm ─┐
                 ├─ xcode-shared-mux ─ 多个标签页/分屏 ─ PowerShell 7
办公本 xcode ─ Tailscale ─ Windows OpenSSH ─ WezTerm SSH mux ─┘
```

## 先说明一个边界

它不能把已经打开的 `powershell.exe` 或 Windows Terminal 窗口“搬进”远程会话。安装时会在主力机打开一个新的 WezTerm 工作区；以后在这个工作区里创建的标签页和分屏，主力机和办公本才能同时看见。体验与在主力机开多个 PowerShell 窗格一致。

## 一次性安装

主力机：

1. 用你以后日常工作的 Windows 管理员账户登录。
2. 双击 `install-main.cmd`。
3. 按提示登录 Tailscale。安装器会打开新的主力机 WezTerm 工作区和一个 10 分钟配对窗口。
4. 保持配对窗口打开。

办公本：

1. 把本仓库复制或 `git clone` 到办公本。
2. 用办公本上自己的 Windows 管理员账户双击 `install-office.cmd`。
3. 登录与主力机相同的 Tailscale 账户。
4. 输入主力机显示的 8 位配对码；在主力机批准办公本节点。
5. 两边核对完全相同的 SSH 主机指纹。
6. 安装器会实际打开一次 `XCODE_MAIN`。看到主力机的 PowerShell 工作区后输入 `y`，配对才会永久提交。

以后新开一个办公本 PowerShell，运行：

```powershell
xcode
```

其他命令：

```powershell
xcode doctor   # 检查 Tailscale、固定主机密钥的 SSH、版本和远端 mux
xcode ssh      # 紧急使用普通 SSH；该窗口本身不持久
```

在 WezTerm 中按 `Ctrl+Shift+Alt+D` 是安全分离。直接关闭某个远程窗格或标签页，会结束那个 PowerShell 进程。

## 这套设计为什么不是“普通 SSH”

普通 SSH 断开后，交互式 shell 通常随连接结束。本项目让 OpenSSH 只负责加密传输和身份认证，再让办公本 WezTerm 附着到主力机的独立 mux。网络切换或办公本 GUI 分离后，主力机上的窗格仍继续运行。

Windows 目前不能作为 Tailscale SSH server，因此这里使用的是 Tailscale 私网中的标准 Windows OpenSSH，而不是 `tailscale ssh`。

## 安全设计

- `sshd` 只监听主力机的 Tailscale IPv4，不监听局域网或公网地址。
- Windows 防火墙规则同时限定 Tailscale 网卡、本机 Tailscale IP、Tailscale 来源网段和 `sshd.exe`。
- 密码、键盘交互认证和 SSH 转发全部关闭，只接受 Ed25519 公钥。
- SSH 服务在首次安装后保持关闭；只有办公本密钥写入并完成验证回执后才启动。预提交期间服务保持 Manual，ACL 保护的事务日志和隐藏 watchdog 会在配对进程崩溃或超时时撤销密钥、服务与防火墙变更。
- 办公本密钥带 `from=` 限制，只能从配对时那个 Tailscale 节点的 `/32` 和 `/128` 地址使用。
- 配对响应由一次性配对码做 HMAC 证明，并再次核对 Tailscale StableID、返回字段和 SSH 指纹，避免把网络字段直接写入配置。
- `administrators_authorized_keys` 使用同目录临时文件原子替换，最终 ACL 只允许 SYSTEM 和 Administrators。
- 办公本使用一个专用、无口令的 SSH 私钥，以实现真正的一条命令连接。它依赖 Windows 用户 ACL、Tailscale 设备身份和来源地址限制共同保护；私钥不会离开办公本。

如果 UAC 要求输入“另一个”管理员账户，安装器会检测到 SID 改变并停止，防止把私钥、PATH 或远程管理员权限装到错误账户。请直接登录你打算使用的管理员账户后重试。

## 丢失办公本或撤销权限

先在 Tailscale 的 Machines 页面删除/禁用丢失的办公本，再在主力机运行：

```text
unpair-office.cmd
```

选择对应的节点和 SSH 指纹即可撤销主力机上的公钥。两步都做，能够同时撤销 Tailscale 网络身份和 SSH 凭据。

## 持久性限制

- 办公本断网、换 Wi-Fi 或安全分离，不会结束主力机窗格。
- 主力机重启、WezTerm mux 崩溃或显式关闭窗格，会结束对应运行状态。
- WezTerm 不提供单写者锁；不要同时从两台电脑向同一个窗格输入。
- 主力机必须开机且不能睡眠。Tailscale 和 SSH 本身不能唤醒睡眠中的电脑。
- 主力机本地 WezTerm 与 SSH 登录必须是同一个 Windows 用户，才能看见同一个 mux。
- 需要 WezTerm 20240203 或更新版本，而且两台机版本必须完全一致。

Tailscale 设备密钥有独立到期策略。需要无人值守时，可以只对主力机关闭 Tailscale key expiry；办公本保留到期机制，丢失时风险更低。

## 对现有配置的处理

- 如果主力机已有非 xcode 管理且正在运行的 OpenSSH，安装器会拒绝接管。
- 如果主力机已有 `.wezterm.lua`，安装器会先明确询问是否备份并替换；默认不覆盖。
- 安装器不会卸载已经存在的软件。机器级 SSH 配置、服务和防火墙修改在失败时会尽量回滚；Tailscale 登录和已安装的软件会保留，方便重试。
- 稳定版 WezTerm 的 SSH 解析器不能可靠处理带空格的 identity/known-hosts 路径。因此 Windows 用户配置文件路径包含空格时，安装器会安全停止并说明原因。

## 写入的主要文件

主力机：

- `%USERPROFILE%\.wezterm.lua`（已有文件需明确同意，且会备份）
- `%LOCALAPPDATA%\XcodeRemote\host-user.json`
- `%ProgramData%\XcodeRemote\host.json`
- `%ProgramData%\XcodeRemote\wezterm-proxy.cmd`（ACL 收紧的无空格远端启动代理）
- `%ProgramData%\XcodeRemote\pairing-pending.json`（仅在未提交配对期间短暂存在）
- `%ProgramData%\ssh\sshd_config`（原文件带时间戳备份）
- `%ProgramData%\ssh\administrators_authorized_keys`

办公本：

- `%USERPROFILE%\.ssh\xcode_office_ed25519`
- `%LOCALAPPDATA%\XcodeRemote\known_hosts`
- `%LOCALAPPDATA%\XcodeRemote\ssh_config`
- `%LOCALAPPDATA%\XcodeRemote\office-wezterm.lua`
- `%LOCALAPPDATA%\XcodeRemote\bin\xcode.cmd`

## 上线前的两机实测

仓库内验证覆盖 PowerShell 语法、配对证明、密钥解析、SSH 配置幂等性和凭据扫描；真正的 Windows-to-Windows mux 仍必须在两台真实机器上跑一次：

1. 主力机创建三个窗格，办公本运行 `xcode`，确认看到相同窗格。
2. 办公本安全分离、切换网络后重连。
3. 两台机分别重启后运行 `xcode doctor`。
4. 关闭 Tailscale，从局域网确认主力机 TCP 22 不可达。

## 官方资料

- [Microsoft：安装 Windows OpenSSH](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse)
- [Microsoft：Windows OpenSSH 密钥管理与 ACL](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement)
- [Tailscale：Windows unattended mode](https://tailscale.com/docs/how-to/run-unattended)
- [Tailscale：Tailscale SSH 平台限制](https://tailscale.com/kb/1193/tailscale-ssh)
- [WezTerm：multiplexing](https://wezterm.org/multiplexing.html)
- [WezTerm：SSH domains](https://wezterm.org/config/lua/SshDomain.html)
