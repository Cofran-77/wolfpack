<#
.SYNOPSIS
    Wolfpack 台账状态汇总工具 (ledger-status.ps1).

.DESCRIPTION
    读取并解析 Wolfpack 派活台账文件 (runs.ndjson)，按 taskId 折叠并倒序输出.

    【数据来源 / Data Source】
    1. 若命令行参数 -Path 非空，优先使用 -Path.
    2. 若环境变量 DSH_HOME 非空，使用: <DSH_HOME>\wolfpack\runs.ndjson.
    3. 否则默认使用: <USERPROFILE>\.dsh\wolfpack\runs.ndjson.

    【字段含义 / Field Definitions】
    - TASK_ID: 任务标识 (taskId)，多轮派活共用同一个 taskId.
    - ROUNDS: 轮数，该 taskId 在台账中出现的记录条数.
    - VERDICT: 验收结论，最后一条带 verdict 字段的记录的值 (pass / fail / unverified 等).
    - TOKENS: 累计消耗，字段 tokens 的累计和（缺失按 0 计）.
    - STOP_REASON: 终止原因，最后一条记录的 stopReason 字段 (如 completed / error / aborted).
    - AT: 时间戳，最后一条记录的 at 字段 (毫秒数或 ISO 8601，用于倒序排序).
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0, Mandatory = $false)]
    [string]$Path
)

# 确保全局捕获异常，任何情况下都不抛出未捕获异常.
$headerPrinted = $false
$header = "TASK_ID`tROUNDS`tVERDICT`tTOKENS"

try {
    # 1. 解析台账文件路径.
    if ([string]::IsNullOrWhiteSpace($Path)) {
        $dshHome = [System.Environment]::GetEnvironmentVariable("DSH_HOME")
        if (-not [string]::IsNullOrWhiteSpace($dshHome)) {
            $Path = Join-Path $dshHome "wolfpack\runs.ndjson"
        } else {
            $userProfile = [System.Environment]::GetEnvironmentVariable("USERPROFILE")
            if ([string]::IsNullOrWhiteSpace($userProfile)) {
                $userProfile = $HOME
            }
            $Path = Join-Path $userProfile ".dsh\wolfpack\runs.ndjson"
        }
    }

    # 2. 检查文件是否存在.
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Write-Output $header
        $headerPrinted = $true
        exit 0
    }

    # 3. 读取文件内容；若内容为空则直接打印表头并退出.
    $fileItem = Get-Item -LiteralPath $Path -ErrorAction Stop
    if ($fileItem.Length -eq 0) {
        Write-Output $header
        $headerPrinted = $true
        exit 0
    }

    $lines = Get-Content -LiteralPath $Path -Encoding UTF8 -ErrorAction Stop
    if ($null -eq $lines -or $lines.Count -eq 0) {
        Write-Output $header
        $headerPrinted = $true
        exit 0
    }

    # 4. 逐行解析 NDJSON 并按 taskId 折叠任务.
    $tasks = [ordered]@{}

    foreach ($line in $lines) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        $entry = $null
        try {
            $entry = ConvertFrom-Json -InputObject $line -ErrorAction Stop
        } catch {
            # 某行不是合法 JSON 时跳过该行.
            continue
        }

        # 过滤非对象或缺失 taskId 的记录.
        if ($null -eq $entry -or -not ($entry.PSObject.Properties['taskId'])) {
            continue
        }

        $taskId = [string]$entry.taskId
        if ([string]::IsNullOrWhiteSpace($taskId)) {
            continue
        }

        # 初始化任务记录.
        if (-not $tasks.Contains($taskId)) {
            $tasks[$taskId] = [PSCustomObject]@{
                TaskId     = $taskId
                Rounds     = [long]0
                Verdict    = ''
                StopReason = ''
                Tokens     = [long]0
                At         = $null
                SortKey    = [double]::MinValue
            }
        }

        $task = $tasks[$taskId]

        # 轮数（该 taskId 出现的记录条数）.
        $task.Rounds++

        # 最后一条带 verdict 字段的记录的 verdict.
        if ($entry.PSObject.Properties['verdict'] -and $null -ne $entry.verdict -and [string]$entry.verdict -ne '') {
            $task.Verdict = [string]$entry.verdict
        }

        # 最后一条记录的 stopReason.
        if ($entry.PSObject.Properties['stopReason'] -and $null -ne $entry.stopReason) {
            $task.StopReason = [string]$entry.stopReason
        }

        # 字段 tokens 的累计和（缺失按 0 计）.
        if ($entry.PSObject.Properties['tokens'] -and $null -ne $entry.tokens) {
            $tok = 0
            if ([long]::TryParse([string]$entry.tokens, [ref]$tok)) {
                $task.Tokens += $tok
            }
        }

        # 最后一条记录的 at 时间（用于计算排序权重）.
        if ($entry.PSObject.Properties['at'] -and $null -ne $entry.at) {
            $task.At = $entry.at
            $atNum = [double]0
            if ([double]::TryParse([string]$entry.at, [ref]$atNum)) {
                $task.SortKey = $atNum
            } else {
                $dt = [datetime]::MinValue
                if ([datetime]::TryParse([string]$entry.at, [ref]$dt)) {
                    $task.SortKey = [double]$dt.ToUniversalTime().Ticks
                }
            }
        }
    }

    # 5. 输出表头与按最新时间倒序排列的任务记录.
    Write-Output $header
    $headerPrinted = $true

    $sortedTasks = $tasks.Values | Sort-Object -Property SortKey -Descending
    foreach ($t in $sortedTasks) {
        Write-Output "$($t.TaskId)`t$($t.Rounds)`t$($t.Verdict)`t$($t.Tokens)"
    }

    exit 0
} catch {
    # 健壮性保障：任何情况下均不抛出未捕获异常.
    if (-not $headerPrinted) {
        Write-Output $header
    }
    exit 0
}
