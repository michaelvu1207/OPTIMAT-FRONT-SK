import { fetchEdgeFunction, getApiBackend } from './supabase';

export type OperationsMode = 'combined' | 'origins' | 'destinations';
export interface OperationsFilters {
  provider_id?: string; date_from?: string; date_to?: string; status?: string;
  hour_from?: string; hour_to?: string; mode?: OperationsMode; offset?: string;
}
export interface PairChart {
  id: 'outbound_time' | 'return_time' | 'outbound_travel' | 'return_travel' | 'activity_duration';
  n: number; mean: number; min: number; max: number;
  bins: { start: number; count: number }[];
}
export interface PairedAnalysis {
  quality: { source_records: number; single_trip_days: number; multi_trip_days: number;
    missing_client_records: number; missing_time_pairs: number; invalid_sequence_pairs: number;
    unmatched_home_pairs: number; valid_pairs: number; excluded_records: number };
  selected_pairs: number; changed_activity_pairs: number;
  charts: PairChart[];
  points: { city: string; lat: number; lng: number; count: number; home_count: number; activity_count: number }[];
  events: { total: number; mapped: number; unmapped: number };
}
export interface OperationsResult {
  paired_analysis?: PairedAnalysis;
  imports: { id: string; provider_id: number; provider_name: string; filename: string; date_from: string; date_to: string; row_count: number; imported_at: string }[];
  statuses: string[];
  summary: { records: number; riders: number; providers: number; date_from: string | null; date_to: string | null };
  event_summary: { total: number; mapped: number; unmapped: number; missing_time: number };
  heat_points: { city: string; lat: number; lng: number; count: number }[];
  hourly: { hour: number; count: number }[];
  trips: { id: string; source_row: number; date: string; provider_id: number; provider_name: string; origin_city: string | null; destination_city: string | null; pickup_time: string | null; dropoff_time: string | null; status: string | null; origin_mapped: boolean; destination_mapped: boolean }[];
  precision: string; timezone: string;
}

export async function getOperations(filters: OperationsFilters, signal?: AbortSignal) {
  if (getApiBackend() !== 'aws') return { data: null, error: new Error('Operational data requires the AWS API backend.') };
  return fetchEdgeFunction<OperationsResult>('trip-records/operations', {
    params: Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== '' && value != null)),
    signal, timeoutMs: 60000,
  });
}
