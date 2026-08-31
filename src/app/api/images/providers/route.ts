import { NextResponse } from 'next/server'
import { getProviderStatuses, getConfiguredTierCount, TOTAL_TIERS } from '@/lib/image-providers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/images/providers — returns the 5-tier provider chain status for the
 * UI provider-chain card. Shows which tiers are configured + their reasons.
 * NOTE: Cloudflare credentials are NEVER exposed here — only configured:true/false.
 */
export async function GET() {
  const providers = getProviderStatuses()
  const configuredCount = getConfiguredTierCount()
  return NextResponse.json({
    total: TOTAL_TIERS,
    configured: configuredCount,
    providers
  })
}
