use std::{
    collections::BTreeMap,
    hint::black_box,
    time::{Duration, Instant},
};

use chrono::NaiveDate;
use commit_ia_task_lib::time_log::{TimeLogBatchInput, TimeLogType, TimeLogWork, plan_time_logs};

fn main() {
    let today = NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
    for (name, count, start, end) in [
        ("semana_20_trabalhos", 20, "2025-12-22", "2025-12-26"),
        ("ano_1000_trabalhos", 1_000, "2025-01-01", "2025-12-31"),
        ("decada_10000_trabalhos", 10_000, "2016-01-01", "2025-12-31"),
    ] {
        let input = TimeLogBatchInput {
            work_item_id: 42,
            start_date: start.into(),
            end_date: end.into(),
            work: (0..count)
                .map(|index| TimeLogWork {
                    minutes: 420,
                    kind: match index % 3 {
                        0 => TimeLogType::Backend,
                        1 => TimeLogType::Frontend,
                        _ => TimeLogType::Teste,
                    },
                    comment: format!("Trabalho {index}"),
                })
                .collect(),
        };
        let used = BTreeMap::new();
        let mut samples = Vec::new();
        for _ in 0..7 {
            let started = Instant::now();
            let mut iterations = 0;
            while started.elapsed() < Duration::from_millis(100) {
                black_box(plan_time_logs(black_box(&input), black_box(&used), today).unwrap());
                iterations += 1;
            }
            samples.push(started.elapsed().as_nanos() / iterations);
        }
        samples.sort_unstable();
        println!("{name}: {} ns/op (mediana de 7 amostras)", samples[3]);
    }
}
