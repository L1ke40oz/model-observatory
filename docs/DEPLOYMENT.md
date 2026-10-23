# GitHub Actions 自动部署

此配置用于已经按 README 部署、项目位于 `/opt/model-observatory` 的 Linux VPS。保留现有 1Panel / OpenResty 反向代理和 HTTPS 设置。

推送到 `main` 后，GitHub Actions 先执行语法检查、测试和容器构建及健康检查，再通过 SSH 更新 VPS。PR 只检查，不使用部署密钥。Actions 中的部署任务串行运行，VPS 另有文件锁，旧版本任务不会覆盖较新的 main。可以在 Actions 页面手动执行工作流。

## 1. 在 1Panel 的服务器终端安装部署命令

以当前负责项目部署、能直接执行 Docker 的用户操作。下面命令按之前使用的 root 用户和项目目录编写：

```sh
cd /opt/model-observatory
git pull --ff-only
install -m 755 scripts/deploy.sh /usr/local/bin/model-observatory-deploy
```

服务器需要 `git`、`docker compose`、`curl`、`flock`，并可访问 GitHub 和 Docker 镜像源。不要在 OpenResty 容器的终端执行这些步骤。

`scripts/deploy.sh` 中的目录固定为 `/opt/model-observatory`；如果实际使用其他路径，先修改安装副本里的 `observatory_dir`。以后修改仓库中的部署脚本后，需要重新执行上述 `install` 来更新服务器副本。

## 2. 创建专用密钥

在同一用户的服务器终端执行一次。如果密钥文件已存在，保留现有文件，不要覆盖。

```sh
mkdir -p ~/.ssh
chmod 700 ~/.ssh
ssh-keygen -t ed25519 -C model-observatory-actions -f ~/.ssh/model-observatory-actions -N ''
printf 'restrict,command="/usr/local/bin/model-observatory-deploy" %s\n' "$(cat ~/.ssh/model-observatory-actions.pub)" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

这把密钥只允许执行固定部署命令。GitHub 发送待部署的提交 SHA，脚本校验其为当前 main 的提交，再进行更新；密钥不能用于交互终端或端口转发。SSH 用户必须允许公钥登录，VPS 的实际 SSH 端口需要能从 GitHub 托管运行器访问。

## 3. 在 GitHub 添加仓库 Secrets

进入仓库 **Settings → Secrets and variables → Actions → New repository secret**，添加以下内容。每项分别创建，私钥不要写进源码或发送到聊天。

| 名称 | 内容 |
| --- | --- |
| `SSH_HOST` | VPS 的真实公网 IP 或直连 SSH 域名；不要填写 HTTP/CDN 代理地址 |
| `SSH_PORT` | VPS 的 SSH 端口，未设置时使用 `22`；不是 1Panel 网页面板端口 |
| `SSH_USER` | 上一步创建密钥的登录用户，例如 `root` |
| `SSH_PRIVATE_KEY` | `~/.ssh/model-observatory-actions` 的完整内容，包括 BEGIN / END 行 |
| `SSH_KNOWN_HOSTS` | VPS 的 SSH 主机公钥，按下一段生成；与上面的登录公钥不同 |

只在终端查看私钥并直接粘贴到 GitHub Secret：

```sh
cat ~/.ssh/model-observatory-actions
```

在服务器终端填入与 Secrets 完全相同的主机和端口，生成 `SSH_KNOWN_HOSTS`：

```sh
read -r -p 'SSH_HOST（公网 IP 或 SSH 域名）: ' observatory_host
read -r -p 'SSH_PORT（回车默认 22）: ' observatory_port
observatory_port=${observatory_port:-22}
observatory_known_host=$observatory_host
if [ "$observatory_port" != 22 ]; then
  observatory_known_host="[$observatory_host]:$observatory_port"
fi
awk -v host="$observatory_known_host" '{print host " " $1 " " $2}' /etc/ssh/ssh_host_ed25519_key.pub
```

把输出的一整行填入 `SSH_KNOWN_HOSTS`。它来自服务器自身的主机公钥，工作流会严格校验，不会在连接时自动信任未知主机。如果 sshd 自定义了主机密钥路径，使用其实际生效的主机公钥文件。

## 4. 首次运行

打开 **Actions → Check and deploy → Run workflow**，选择 `main` 并运行。首次检查、构建和部署可能需要几分钟。`Check application` 和 `Deploy VPS` 都成功后完成接入；之后推送 main 自动部署。

新增工作流的首次 push 会先执行检查；如果尚未配置 Secrets，部署任务会提示缺失配置并失败。配置完成后手动运行即可。

## 部署失败时

- 构建失败：保留原容器，任务失败。
- 新容器启动或健康检查失败：尝试用之前容器的镜像恢复，任务仍标记失败，便于发现问题。源码保持在请求的提交，下一次 main 更新可以继续快进部署。
- VPS 上改动了受 Git 跟踪的文件：任务会停止，不自动覆盖改动；先处理本机修改。`sites.json` 也属于受跟踪文件。
- 修改业务代码可以直接推送；修改部署脚本后需手动重新安装服务器上的部署命令。
- 站点和关注配置保存在访客浏览器中，部署使用同一域名时继续保留。脚本不修改 OpenResty、DNS 或证书，也不执行 Docker 全局清理。

可在服务器检查：

```sh
cd /opt/model-observatory
docker compose ps
docker compose logs --tail=50 stella
curl -fsS http://127.0.0.1:8787/api/health
```
