param(
    [Parameter(Mandatory = $true)]
    [string]$Path
)

$ErrorActionPreference = "Stop"
$signature = Get-AuthenticodeSignature -LiteralPath $Path
[ordered]@{
    Status = [string]$signature.Status
    Subject = if ($null -eq $signature.SignerCertificate) { $null } else { [string]$signature.SignerCertificate.Subject }
    TimestampSubject = if ($null -eq $signature.TimeStamperCertificate) { $null } else { [string]$signature.TimeStamperCertificate.Subject }
} | ConvertTo-Json -Compress
