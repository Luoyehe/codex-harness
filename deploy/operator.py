"""Interactive front door to the existing, journaled deployment commands."""
from __future__ import annotations

import getpass
import json
import os
import platform
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path

from .common import DeployError, INSTANCE, Layout, require
from .dns_providers import PROVIDERS
from .edge_defaults import DEFAULT_HTTP_PORT, DEFAULT_HTTPS_PORT


class Cancelled(Exception):
    pass


def installed_instances(directory: Path = Path("/etc/codex-harness")) -> list[str]:
    if not directory.exists():
        return []
    return sorted(path.name for path in directory.iterdir()
                  if INSTANCE.fullmatch(path.name) and path.is_dir() and not path.is_symlink())


def require_host() -> None:
    require(platform.system() == "Linux" and hasattr(os, "geteuid") and os.geteuid() == 0,
            "请在 Linux 服务器上使用 sudo sh ./harness.sh 启动管理菜单。", "unsupported_platform")
    release = {}
    for line in Path("/etc/os-release").read_text().splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            release[key] = value.strip('"')
    require((release.get("ID"), release.get("VERSION_ID")) in (("ubuntu", "24.04"), ("debian", "12")),
            "支持 Ubuntu 24.04 和 Debian 12。", "unsupported_platform")
    require(Path("/sys/fs/cgroup/cgroup.controllers").is_file(),
            "需要使用 cgroup v2 的 systemd 主机。", "prerequisite")


class Console:
    def __init__(self, instance: str, *, source: Path | None = None, execute=None,
                 ask=None, secret=None, output=None):
        Layout(instance)
        self.instance = instance
        self.source = (source or Path(__file__).resolve().parent.parent).resolve()
        self.execute = execute
        self.ask = ask or input
        self.secret = secret or getpass.getpass
        self.output = output or print

    def prompt(self, label: str, default: str | int = "") -> str:
        value = self.ask(label + (f" [{default}]" if default != "" else "") + ": ").strip()
        if value.lower() == "q":
            raise Cancelled()
        return value or str(default)

    def choice(self, label: str, items: dict[str, str], default: str = "") -> str:
        self.output(label)
        for key, title in items.items():
            self.output(f"  {key}. {title}")
        while True:
            value = self.prompt("请选择", default)
            if value in items:
                return value
            self.output("请输入菜单中的编号，或输入 q 取消。")

    def confirm(self, label: str, *, default: bool = False) -> bool:
        while True:
            value = self.prompt(label + " (y/n)", "y" if default else "n").lower()
            if value in ("y", "yes", "n", "no"):
                return value in ("y", "yes")
            self.output("请输入 y 或 n。")

    def port(self, label: str, default: int, *, minimum: int = 1024) -> int:
        while True:
            value = self.prompt(label, default)
            if value.isascii() and value.isdecimal() and minimum <= int(value) <= 65535:
                return int(value)
            self.output(f"请输入 {minimum}–65535 之间的端口。")

    def command(self, name: str, *arguments: str) -> dict:
        from .cli import execute, parser
        self.output(f"正在执行：{name}（实例 {self.instance}）")
        result = (self.execute or execute)(parser().parse_args(["--instance", self.instance, name, *arguments]))
        if isinstance(result, dict) and result.get("ok") is False:
            error = result.get("error", {})
            raise DeployError(error.get("code", "management_error"), error.get("message", "操作失败"))
        return result

    def prepare_dependencies(self) -> None:
        needed = ("/usr/bin/sudo", "/usr/sbin/visudo", "/usr/sbin/mkfs.ext4", "/usr/bin/mount",
                  "/usr/bin/umount", "/usr/bin/setpriv", "/usr/bin/bwrap", "/usr/bin/git")
        if all(Path(binary).is_file() for binary in needed) and Path("/etc/ssl/certs/ca-certificates.crt").is_file():
            return
        self.output("需要安装系统依赖：git、sudo、e2fsprogs、util-linux、mount、bubblewrap、ca-certificates。")
        if not self.confirm("现在通过系统 apt 仓库安装", default=True):
            raise Cancelled()
        for command in (["/usr/bin/apt-get", "update"], ["/usr/bin/apt-get", "install", "-y", "git", "sudo",
                         "e2fsprogs", "util-linux", "mount", "bubblewrap", "ca-certificates"]):
            result = subprocess.run(command, check=False, timeout=1800, cwd="/", close_fds=True,
                                    env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8", "HOME": "/root",
                                         "DEBIAN_FRONTEND": "noninteractive"})
            require(result.returncode == 0, "系统依赖安装失败；修正 apt 网络或软件源后重试。", "prerequisite")

    @contextmanager
    def source_archive(self):
        # A unique private directory avoids overwriting a user's archive. Keep
        # failed inputs for explicit recovery; remove only our two exact paths.
        directory = Path(tempfile.mkdtemp(prefix="codex-harness-source-"))
        archive = directory / "source.tgz"
        try:
            self.command("pack-source", "--source", str(self.source), "--output", str(archive))
            yield archive
        except BaseException:
            self.output(f"本次源码包保留在 {archive}，可用于恢复中断的安装或升级。")
            raise
        else:
            archive.unlink(missing_ok=True)
            directory.rmdir()

    def install(self) -> None:
        layout = Layout(self.instance)
        require(not layout.config.exists(), "该实例已有配置；请选择升级或恢复，不要重复安装。", "already_installed")
        self.prepare_dependencies()
        port = self.port("内部服务端口（仅监听本机）", 3300)
        username = self.prompt("管理员用户名", "admin")
        self.output("接下来设置管理员密码（至少 12 个字符）；输入时不显示。")
        if not self.confirm(f"安装实例 {self.instance}，内部端口 {port}", default=True):
            return
        with self.source_archive() as archive:
            self.command("install", "--source", str(archive), "--origin", f"http://127.0.0.1:{port}",
                         "--port", str(port), "--username", username)
        self.output("安装完成，服务已启动。")
        if self.confirm("现在配置域名和 HTTPS 外网访问", default=True):
            self.https(username=username)
        else:
            self.output(f"先在自己的电脑运行：ssh -N -L 127.0.0.1:{port}:127.0.0.1:{port} 用户名@服务器地址")
            self.output(f"保持 SSH 连接后打开 http://127.0.0.1:{port}；可随时从本菜单配置 HTTPS。")

    def update(self) -> None:
        self.output(f"将使用当前源码目录：{self.source}")
        self.output("请先在这个独立目录取得并检查要升级的版本。应用、账号、项目和证书数据会保留。")
        require(len(list(Layout(self.instance).work.glob("candidate-*"))) < 8,
                "已保留 8 个构建候选。先进入「修复 / 恢复 / 回滚」→「归档已完成构建」，核对并归档一个候选后重试升级；不会自动删除任何内容。", "budget")
        if not self.confirm("更新控制工具、配置层和应用（期间会短暂重启服务）"):
            return
        self.prepare_dependencies()
        with self.source_archive() as archive:
            # Stop immediately on failure; an unresolved control transaction
            # must never be followed by an application activation.
            self.command("control-update")
            self.command("config-layer-migrate")
            self.command("update", "--source", str(archive))
        self.output("升级完成。")
        self.status()

    @contextmanager
    def dns_credentials(self, provider: str, *, reuse: bool):
        schema = PROVIDERS[provider]
        self.output(schema.label + "：" + schema.credential_description)
        self.output("凭证权限说明：" + schema.documentation)
        choices = {"1": "安全输入 API 凭证", "2": "使用服务器上已有的凭证 JSON 文件"}
        if reuse:
            choices["3"] = "保留当前已配置的凭证"
        mode = self.choice("DNS API 凭证", choices, "3" if reuse else "1")
        if mode == "3":
            yield None
            return
        if mode == "2":
            path = Path(self.prompt("凭证 JSON 的绝对路径"))
            require(path.is_absolute(), "请填写凭证文件的绝对路径。")
            yield str(path)
            return
        values = {}
        for field in schema.fields:
            while True:
                value = self.prompt(field.name, "us-east-1") if field.kind == "region" else self.secret(field.name + "（输入隐藏）: ")
                if field.accepts(value):
                    values[field.name] = value
                    break
                self.output("格式不正确，请重新输入；值不会写入屏幕或命令参数。")
        # The existing HTTPS command imports this file into its protected
        # immutable generation; the input file is never a renewal dependency.
        with tempfile.TemporaryDirectory(prefix="codex-harness-dns-input-") as folder:
            path = Path(folder) / "credentials.json"
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(values, stream)
            try:
                yield str(path)
            finally:
                values.clear()

    def https(self, *, username: str | None = None) -> None:
        from .https import site_origin
        try:
            current = self.command("https-read")
        except DeployError as exc:
            if exc.code != "not_installed":
                raise
            current = None
        settings = current.get("settings", {}) if current else {}
        host = self.prompt("域名（不带 https:// 和端口）", settings.get("host") or "")
        tls_port = self.port("网页 HTTPS 端口", settings.get("httpsPort") or DEFAULT_HTTPS_PORT, minimum=1)
        http_port = self.port("HTTP 验证/跳转端口", settings.get("httpPort") or DEFAULT_HTTP_PORT, minimum=1)
        unchanged_address = host == settings.get("host") and tls_port == settings.get("httpsPort")
        direct_origin = site_origin(host, tls_port)
        public = self.prompt("浏览器访问地址（仅在公网转发端口不同的情况下修改）",
                             (settings.get("publicOrigin") if unchanged_address else None) or direct_origin)
        default = "1" if settings.get("dnsProvider") else "3" if settings.get("tls") == "provided" else "4" if settings.get("tls") == "internal" else "2"
        mode = self.choice("证书方式", {"1": "DNS 自动验证（公网 80/443 不开放时选择）", "2": "普通自动验证（公网 80 或 443 可转发到本机）",
                                        "3": "使用自己的证书和私钥", "4": "内部测试证书（客户端需要信任本地 CA）"}, default)
        tls = {"1": "acme", "2": "acme", "3": "provided", "4": "internal"}[mode]
        provider = None
        if mode == "1":
            providers = list(PROVIDERS)
            selected = self.choice("选择域名的权威 DNS 平台", {str(i + 1): PROVIDERS[key].label for i, key in enumerate(providers)},
                                   str(providers.index(settings["dnsProvider"]) + 1) if settings.get("dnsProvider") in PROVIDERS else "1")
            provider = providers[int(selected) - 1]
        arguments = ["--host", host, "--tls", tls, "--http-port", str(http_port), "--https-port", str(tls_port)]
        if tls == "acme":
            arguments += ["--dns-provider", provider or "none"]
        plan = self.command("https-plan", *arguments, "--public-origin", public)
        # Resuming older metadata must preserve the distinction between an
        # omitted origin and an explicitly recorded, equivalent direct origin.
        if not (unchanged_address and settings.get("publicOrigin") is None and plan["origin"] == direct_origin):
            arguments += ["--public-origin", public]
        self.output("访问地址：" + plan["origin"])
        self.output(f"请确认域名解析指向公网入口，并开放/转发网页 TCP {plan['browserIngress']['publicPort']} → 本机 {tls_port}。")
        if mode == "2":
            self.output(f"还必须具备至少一条验证通路：公网 TCP 80 → {http_port}，或公网 TCP 443 → {tls_port}（TLS 透传）。")
        elif mode == "1":
            self.output("不需要公网 80/443。API 凭证需要该域名的 DNS 记录管理权限；首次构建 DNS 组件可能较慢。")
        elif mode == "4":
            self.output("内部证书不会自动被浏览器信任；正式公网使用请选择自动验证或自有证书。")
        if not self.confirm("按以上方案配置 HTTPS"):
            return
        if mode == "3":
            arguments += ["--certificate", self.prompt("证书 PEM 绝对路径"), "--private-key", self.prompt("私钥 PEM 绝对路径")]
            ca = self.prompt("自定义 CA PEM 绝对路径（留空使用系统信任）")
            arguments += ["--tls-ca-certificate", ca] if ca else ["--tls-system-ca"]
        arguments += ["--username", username or self.prompt("管理员用户名", "admin")]
        if self.confirm("管理员已开启两步验证"):
            arguments.append("--two-factor")
        command = "https"
        if settings.get("authentication") == "builtin" and settings.get("phase") == "active":
            command = "https-migrate"
            arguments += ["--expected-origin", current["origin"], "--expected-https-revision", current["httpsRevision"]]
        if provider:
            with self.dns_credentials(provider, reuse=settings.get("dnsProvider") == provider) as credentials:
                self.command(command, *arguments, *(["--dns-credentials", credentials] if credentials else []))
        else:
            self.command(command, *arguments)
        self.output("HTTPS 配置完成。请从外部网络打开 " + plan["origin"] + "，检查证书并登录。")
        if tls == "acme":
            self.output("Caddy 已配置自动续期；请保持服务运行以及验证通路/凭证有效。")

    def status(self) -> None:
        value = self.command("status")
        self.output("访问地址：" + str(value.get("origin", "尚未配置")))
        for role, state in value.get("services", {}).items():
            self.output(f"{role}: {state.get('ActiveState', 'unknown')} / {state.get('SubState', 'unknown')}")
        https = value.get("https", {})
        if https.get("ready"):
            self.output("HTTPS 证书及实例校验通过。")
        elif https.get("failure") == "not_configured":
            self.output("尚未配置 HTTPS；从菜单选择“域名、证书和 HTTPS”。")
        else:
            self.output("HTTPS 需要检查：" + str(https.get("failure", "unknown")))
        if self.confirm("同时进行文件和配置完整性诊断（可能需要一些时间）"):
            self.command("verify")
            self.output("完整性诊断通过。")

    def logs(self) -> None:
        role = self.choice("查看日志", {"1": "网关 / 登录和网页连接", "2": "运行时 / 模型和任务", "3": "HTTPS / 证书签发和续期"}, "1")
        value = self.command("logs", "--service", {"1": "gateway", "2": "worker", "3": "caddy"}[role], "--lines", "100")
        value = value.get("result", value)
        self.output(value.get("text", value.get("logs", json.dumps(value, ensure_ascii=False))))

    def reset_account(self) -> None:
        username = self.prompt("新的管理员用户名", "admin")
        self.output("将设置新的用户名和密码，清除两步验证，并撤销原有登录设备。项目和模型配置保留。")
        if not self.confirm("确认重置管理员账号"):
            return
        result = self.command("account-reset", "--username", username)
        if result.get("loginVerified"):
            self.output("管理员已重置并通过登录验证。请使用新用户名和密码登录。")
        else:
            self.output("重置信息已保存，但网关尚未确认登录。请检查服务状态并恢复网关，然后用新账号登录；不要重复重置。")

    def archive_candidates(self) -> None:
        result = self.command("candidate-list")
        eligible = [row for row in result.get("candidates", []) if row.get("eligible")]
        for row in result.get("candidates", []):
            detail = ("继续归档，发布 " if row.get("resume") else "可归档，发布 ") + row.get("release", "")[:12]
            self.output(row["id"] + "：" + (detail if row.get("eligible") else "保留，" + row.get("reason", "证据不足")))
        if not eligible:
            self.output("没有通过完整验证的候选；未完成或状态不明确的构建不会移动。")
            return
        selected = self.choice("选择要归档的已完成构建", {str(index + 1): row["id"] for index, row in enumerate(eligible)})
        candidate = eligible[int(selected) - 1]["id"]
        self.output("归档只移动构建缓存，保留发布版本、配置、账号、项目、凭据和全部事务记录。归档会释放候选名额，不减少磁盘占用。")
        self.output("期间会短暂停止当前实例并恢复原服务。请先完成任务并关闭终端；状态不明时先恢复服务。")
        if self.confirm("归档候选 " + candidate + " 并短暂停机"):
            self.command("candidate-archive", "--candidate", candidate, "--confirm-stop")
            self.output("归档完成，原服务已恢复。现在可继续升级。")

    def recover(self) -> None:
        choice = self.choice("按发生中断的阶段恢复", {"1": "修复未完成的应用、供应商或 HTTPS 更新", "2": "恢复中断的控制工具更新",
                            "3": "继续首次安装初始化", "4": "恢复卸载后保留的服务", "5": "回滚到上一个应用版本", "6": "归档已完成构建（释放升级名额）"})
        if choice == "6":
            self.archive_candidates()
            return
        command = {"1": "repair", "2": "control-recover", "3": "install-resume", "4": "restore-services", "5": "rollback"}[choice]
        if not self.confirm("执行恢复操作 " + command):
            return
        if command == "install-resume":
            with self.source_archive() as archive:
                self.command(command, "--source", str(archive))
        else:
            self.command(command)
        self.output("恢复操作完成，请查看状态并在网页确认。")

    def loop(self) -> None:
        actions = {"1": self.install, "2": self.update, "3": self.https, "4": self.status, "5": self.logs,
                   "6": self.reset_account, "8": self.recover}
        while True:
            try:
                choice = self.choice(f"\nCodex Harness 管理 · {self.instance}", {"1": "安装新实例", "2": "升级当前实例",
                    "3": "域名、证书和 HTTPS", "4": "状态与诊断", "5": "查看日志", "6": "重置管理员用户名和密码",
                    "7": "重启服务", "8": "修复 / 恢复 / 回滚", "9": "切换或新建实例名称", "0": "退出"})
                if choice == "0":
                    return
                if choice == "9":
                    self.select_instance()
                elif choice == "7":
                    if self.confirm("重启当前实例服务（会中断正在执行的任务）"):
                        self.command("restart")
                        self.output("服务已重启。")
                else:
                    actions[choice]()
            except Cancelled:
                self.output("已取消，返回主菜单。")
            except DeployError as exc:
                self.output(f"操作未完成 [{exc.code}]：{exc}")
                self.output("保留现有数据和恢复记录。请先查看状态/日志，按提示修复；不会自动重试或重复提交。")
            except (EOFError, KeyboardInterrupt):
                self.output("\n已退出；已执行的步骤不会自动撤销。")
                return
            except Exception:
                self.output("操作未完成。请查看状态和日志、检查保留的恢复记录；不会自动重试。")

    def select_instance(self, *, prefer_current: bool = False) -> None:
        known = installed_instances()
        if known:
            self.output("已有实例：" + "、".join(known))
        value = self.prompt("实例名称（小写字母开头，最多 20 个字母/数字/连字符）",
                            known[0] if len(known) == 1 and not prefer_current else self.instance)
        Layout(value)
        self.instance = value


def manage(instance: str = "main") -> None:
    require(sys.stdin.isatty(), "交互菜单需要终端；自动化请继续使用 deploy.cli 子命令。", "interactive_required")
    require_host()
    console = Console(instance)
    console.output("输入 q 可取消当前页面。密码和 DNS 密钥均隐藏输入。")
    try:
        console.select_instance(prefer_current=instance != "main")
    except (Cancelled, EOFError, KeyboardInterrupt):
        return
    console.loop()
