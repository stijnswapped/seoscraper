// Area chart of daily scrape volume. Shared by Stats + Overview.

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import type { UsageDailyPoint } from "../api.js";
import { fmtDay } from "../lib/format.js";

export function UsageChart({ data, height = 300 }: { data: UsageDailyPoint[]; height?: number }) {
  if (data.length === 0) {
    return <div className="empty-chart">No scrapes recorded yet.</div>;
  }
  return (
    <div className="chart-wrap">
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ left: -16, right: 8, top: 8, bottom: 0 }}>
          <defs>
            <linearGradient id="fillTotal" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#4f46e5" stopOpacity={0.16} />
              <stop offset="100%" stopColor="#4f46e5" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#eef0f4" vertical={false} />
          <XAxis dataKey="day" tickFormatter={fmtDay} tickLine={false} axisLine={false} dy={10} minTickGap={28} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={30} />
          <Tooltip
            cursor={{ stroke: "#d9d9e3", strokeWidth: 1 }}
            contentStyle={{
              borderRadius: 14,
              border: "1px solid #ececf0",
              boxShadow: "0 8px 30px rgba(20,20,40,0.08)",
              padding: "8px 12px",
            }}
            labelFormatter={(d) => fmtDay(String(d))}
          />
          <Area type="monotone" dataKey="total" name="Scrapes" stroke="#4f46e5" strokeWidth={2.5} fill="url(#fillTotal)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
