import { IsEnum } from 'class-validator';
import { DeliveryFrequency } from '../../../plans/plans.constants';

export class ChangeFrequencyDto {
  @IsEnum(DeliveryFrequency, {
    message: `frequency must be one of: ${Object.values(DeliveryFrequency).join(', ')}`,
  })
  frequency: DeliveryFrequency;
}
