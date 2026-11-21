"""Stable user-facing errors for immediate and retained workspace responses."""
from .common import DeployError

MESSAGES = {
    "config_readback_unknown": "已写入原生配置，但未能确认保存结果。请先重新读取设置。",
    "config_conflict": "设置已变化或与原生配置冲突。请重新读取设置并核对原有配置。",
    "capacity": "工作区数据超出容量上限，请在核对现有数据后缩小请求。",
    "already_exists": "目标已存在。请选择其他名称，或刷新后核对现有内容。",
    "not_found": "工作区中的目标不存在。请刷新文件列表后核对。",
    "permission_denied": "当前执行身份没有访问这个工作区资源的权限。",
    "busy": "工作区另有操作正在执行，请稍后查询原操作。",
    "budget": "工作区操作达到容量或遍历上限。请缩小范围，或先处理保留的恢复记录。",
    "conflict": "文件或工作树已发生变化。请刷新并核对最新版本。",
    "operation_conflict": "这个操作编号对应的原始请求不同。请核对原操作记录。",
    "recovery_required": "工作区有待核对的恢复材料，请先检查原操作记录。",
    "unknown": "结果尚未确认，请查询原操作并检查恢复材料。",
    "cleanup_unknown": "无法确认清理结果，请查询原操作并检查保留材料。",
    "stop_unknown": "无法确认原进程已经停止，请先核对其状态。",
    "interrupted": "工作区操作已中断，请查询原操作回执。",
    "timeout": "工作区操作超时，请先核对原操作结果。",
    "corrupt_state": "工作区记录格式或内容异常，请保留记录并检查。",
    "integrity": "工作区材料未通过完整性核对，请检查原记录。",
    "unsafe_path": "工作区路径、文件类型或权限未通过检查。请核对目标。",
    "forbidden_path": "目标超出此项目允许访问的范围。",
    "protected_path_unresolved": "无法确认目标是否位于受保护目录，请核对路径。",
    "unsupported_path": "此路径或文件类型不支持所选操作。",
    "unsupported_resource": "此资源无法用当前工作区操作处理。",
    "unsupported_platform": "当前系统不支持此工作区操作。",
    "invalid_input": "工作区参数无效，请核对目标以及所选版本。",
    "git_scope": "无法确认 Git 仓库的作用范围，请检查仓库绑定。",
    "not_repository_root": "所选项目不是可验证的 Git 工作树根目录。",
    "git_unavailable": "Git 未完成该操作，请检查仓库状态及原操作回执。",
    "empty_commit": "没有可提交的暂存变更。",
    "git_in_progress": "仓库中已有进行中的 Git 操作，请先处理后再检查。",
    "git_conversion_required": "所选文件使用了需要由原生 Git 处理的内容转换。",
    "worktree_unbound": "无法验证工作树的原始绑定，请检查创建或恢复记录。",
    "worktree_shared": "工作树与其他位置共享已登记的资源，请先核对引用。",
    "worktree_origin": "工作树的原始仓库不匹配，请检查绑定。",
    "worktree_primary": "主工作树不支持此操作。",
    "worktree_nested": "工作树包含嵌套仓库，请先检查目录结构。",
    "worktree_dirty": "工作树中还有本地变更，请先处理或保留这些内容。",
}
FALLBACK = "工作区操作失败，请查看原操作记录并核对其送达状态。"


def error_code(exc):
    if isinstance(exc, DeployError):
        return exc.code
    if isinstance(exc, FileExistsError):
        return "already_exists"
    if isinstance(exc, FileNotFoundError):
        return "not_found"
    if isinstance(exc, PermissionError):
        return "permission_denied"
    return "workspace_error"


def response_for_display(response):
    if not isinstance(response, dict) or response.get("ok") is not False or not isinstance(response.get("error"), dict):
        return response
    error = response["error"]
    code = error.get("code")
    if not isinstance(code, str):
        return response
    return {**response, "error": {**error, "message": MESSAGES.get(code, FALLBACK)}}
