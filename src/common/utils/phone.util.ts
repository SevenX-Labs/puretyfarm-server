import { BadRequestException } from '@nestjs/common';

/**
 * Normalizes an Indian mobile number to canonical format (+91XXXXXXXXXX).
 * Accepts:
 * - 9876543210
 * - +919876543210
 * - 919876543210
 * - 09876543210
 */
export function normalizeMobile(mobile: string): string {
  if (!mobile || typeof mobile !== 'string') {
    throw new BadRequestException('Mobile number is required');
  }

  let cleaned = mobile.replace(/[\s\-()]/g, '').trim();

  if (cleaned.startsWith('+91')) {
    cleaned = cleaned.slice(3);
  } else if (cleaned.startsWith('91') && cleaned.length === 12) {
    cleaned = cleaned.slice(2);
  } else if (cleaned.startsWith('0') && cleaned.length === 11) {
    cleaned = cleaned.slice(1);
  }

  if (!/^[6-9]\d{9}$/.test(cleaned)) {
    throw new BadRequestException(
      'Invalid mobile number format. Must be a valid 10-digit Indian mobile number.',
    );
  }

  return `+91${cleaned}`;
}
