param(
    [Parameter(Mandatory=$true)][string]$Executable,
    [Parameter(Mandatory=$true)][string]$ArgumentsBase64,
    [Parameter(Mandatory=$true)][int]$ParentPid
)
$ErrorActionPreference = 'Stop'
try {
    # Import the built-in module explicitly instead of scanning arbitrary module paths.
    $utilityModule = [System.IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1')
    Import-Module -Name $utilityModule -ErrorAction Stop
    Add-Type -Path ([System.IO.Path]::Combine($PSScriptRoot, 'windows-process-tree.cs'))
    $taskArgs = ConvertFrom-Json -InputObject ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgumentsBase64)))
    if ($null -eq $taskArgs) { $taskArgs = @() }
    $taskExitCode = [HomeAgent.ProcessTree]::Run($Executable, [string[]]$taskArgs, $ParentPid)
    exit $taskExitCode
} catch {
    [Console]::Error.WriteLine('HomeAgent process supervisor failed: ' + $_.Exception.Message)
    exit 127
}
