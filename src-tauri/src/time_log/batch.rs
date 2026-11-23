use std::collections::BTreeMap;

use chrono::{Datelike, Days, NaiveDate, Weekday};
use serde::{Deserialize, Serialize};

use super::TimeLogType;

pub const MAX_DAILY_MINUTES: u32 = 7 * 60;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeLogWork {
    pub minutes: u32,
    #[serde(rename = "type")]
    pub kind: TimeLogType,
    pub comment: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeLogBatchInput {
    pub work_item_id: i32,
    pub start_date: String,
    pub end_date: String,
    pub work: Vec<TimeLogWork>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeLogPlanEntry {
    pub date: String,
    pub minutes: u32,
    #[serde(rename = "type")]
    pub kind: TimeLogType,
    pub comment: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeLogPlanDay {
    pub date: String,
    pub existing_minutes: u32,
    pub new_minutes: u32,
    pub total_minutes: u32,
    pub entries: Vec<TimeLogPlanEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeLogPlan {
    pub work_item_id: i32,
    pub requested_minutes: u32,
    pub scheduled_minutes: u32,
    pub missing_minutes: u32,
    pub days: Vec<TimeLogPlanDay>,
}

impl TimeLogPlan {
    pub(crate) fn entries(&self) -> Vec<TimeLogPlanEntry> {
        self.days
            .iter()
            .flat_map(|day| day.entries.iter().cloned())
            .collect()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeLogCreatedEntry {
    pub entry: TimeLogPlanEntry,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeLogBatchFailure {
    pub entry: TimeLogPlanEntry,
    pub error: String,
    pub indeterminate: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeLogBatchResult {
    pub plan: TimeLogPlan,
    pub created: Vec<TimeLogCreatedEntry>,
    pub pending: Vec<TimeLogPlanEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<TimeLogBatchFailure>,
    pub post_attempts: usize,
    pub retryable: bool,
}

impl TimeLogBatchResult {
    pub fn without_posts(plan: TimeLogPlan) -> Self {
        let retryable = plan.missing_minutes > 0 && plan.requested_minutes > 0;
        Self {
            plan,
            created: Vec::new(),
            pending: Vec::new(),
            failure: None,
            post_attempts: 0,
            retryable,
        }
    }

    pub fn empty(work_item_id: i32, start_date: String, end_date: String) -> Self {
        Self::without_posts(TimeLogPlan {
            work_item_id,
            requested_minutes: 0,
            scheduled_minutes: 0,
            missing_minutes: 0,
            days: if start_date == end_date {
                vec![TimeLogPlanDay {
                    date: start_date,
                    existing_minutes: 0,
                    new_minutes: 0,
                    total_minutes: 0,
                    entries: Vec::new(),
                }]
            } else {
                Vec::new()
            },
        })
    }
}

/// Planeja um lote sem efeitos externos.
///
/// `used` já deve conter o total global do usuário autenticado em cada data,
/// independentemente de work item ou tipo.
pub fn plan_time_logs(
    input: &TimeLogBatchInput,
    used: &BTreeMap<NaiveDate, u32>,
    today: NaiveDate,
) -> Result<TimeLogPlan, String> {
    if input.work_item_id <= 0 {
        return Err("o ID deve ser maior que zero".into());
    }

    let start_date = parse_date(&input.start_date, "a data inicial")?;
    let end_date = parse_date(&input.end_date, "a data final")?;
    if start_date > end_date {
        return Err("a data inicial não pode ser posterior à data final".into());
    }
    if end_date > today {
        return Err("não é permitido registrar horas em datas futuras".into());
    }

    let mut requested_minutes = 0_u32;
    for item in &input.work {
        if item.minutes == 0 {
            return Err("cada trabalho deve ter pelo menos um minuto".into());
        }
        if item.comment.trim().is_empty() {
            return Err("o comentário não pode ficar vazio".into());
        }
        requested_minutes = requested_minutes
            .checked_add(item.minutes)
            .ok_or_else(|| "a duração informada é grande demais".to_string())?;
    }

    let mut days = Vec::new();
    let mut date = start_date;
    loop {
        if !matches!(date.weekday(), Weekday::Sat | Weekday::Sun) {
            let existing_minutes = used.get(&date).copied().unwrap_or(0);
            days.push(TimeLogPlanDay {
                date: format_date(date),
                existing_minutes,
                new_minutes: 0,
                total_minutes: existing_minutes,
                entries: Vec::new(),
            });
        }
        if date == end_date {
            break;
        }
        date = date
            .checked_add_days(Days::new(1))
            .ok_or_else(|| "o intervalo de datas é grande demais".to_string())?;
    }

    let mut missing_minutes = 0_u32;
    // Dias sem saldo não recuperam capacidade durante este planejamento.
    let mut day_index = 0;
    for item in &input.work {
        let mut remaining = item.minutes;
        while remaining > 0 && day_index < days.len() {
            let day = &mut days[day_index];
            let available = MAX_DAILY_MINUTES
                .saturating_sub(day.existing_minutes)
                .saturating_sub(day.new_minutes);
            let allocated = available.min(remaining);
            if allocated == 0 {
                day_index += 1;
                continue;
            }

            if let Some(entry) = day.entries.iter_mut().find(|entry| entry.kind == item.kind) {
                entry.minutes = entry
                    .minutes
                    .checked_add(allocated)
                    .ok_or_else(|| "a duração planejada é grande demais".to_string())?;
                entry.comment.push_str("; ");
                entry.comment.push_str(item.comment.trim());
            } else {
                day.entries.push(TimeLogPlanEntry {
                    date: day.date.clone(),
                    minutes: allocated,
                    kind: item.kind,
                    comment: item.comment.trim().to_owned(),
                });
            }

            day.new_minutes = day
                .new_minutes
                .checked_add(allocated)
                .ok_or_else(|| "a duração planejada é grande demais".to_string())?;
            day.total_minutes = day
                .existing_minutes
                .checked_add(day.new_minutes)
                .ok_or_else(|| "a duração diária é grande demais".to_string())?;
            remaining -= allocated;
            if day.total_minutes == MAX_DAILY_MINUTES {
                day_index += 1;
            }
        }
        missing_minutes = missing_minutes
            .checked_add(remaining)
            .ok_or_else(|| "a duração pendente é grande demais".to_string())?;
    }

    Ok(TimeLogPlan {
        work_item_id: input.work_item_id,
        requested_minutes,
        scheduled_minutes: requested_minutes - missing_minutes,
        missing_minutes,
        days,
    })
}

fn parse_date(value: &str, label: &str) -> Result<NaiveDate, String> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| format!("{label} deve existir e usar o formato YYYY-MM-DD"))
}

fn format_date(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(value: &str) -> NaiveDate {
        NaiveDate::parse_from_str(value, "%Y-%m-%d").unwrap()
    }

    fn work(minutes: u32, kind: TimeLogType, comment: &str) -> TimeLogWork {
        TimeLogWork {
            minutes,
            kind,
            comment: comment.to_owned(),
        }
    }

    #[test]
    fn distributes_in_order_skips_weekends_and_consolidates_types() {
        let input = TimeLogBatchInput {
            work_item_id: 42,
            start_date: "2026-08-07".into(),
            end_date: "2026-08-11".into(),
            work: vec![
                work(300, TimeLogType::Backend, "API"),
                work(180, TimeLogType::Frontend, "Tela"),
                work(120, TimeLogType::Backend, "Serviço"),
                work(60, TimeLogType::Teste, "Testes"),
            ],
        };
        let used = BTreeMap::from([(date("2026-08-07"), 90)]);

        let plan = plan_time_logs(&input, &used, date("2026-08-11")).unwrap();

        assert_eq!(plan.requested_minutes, 660);
        assert_eq!(plan.scheduled_minutes, 660);
        assert_eq!(plan.missing_minutes, 0);
        assert_eq!(
            plan.days
                .iter()
                .map(|day| day.date.as_str())
                .collect::<Vec<_>>(),
            ["2026-08-07", "2026-08-10", "2026-08-11"]
        );
        assert_eq!(plan.days[0].existing_minutes, 90);
        assert_eq!(plan.days[0].new_minutes, 330);
        assert_eq!(plan.days[0].entries[0].kind, TimeLogType::Backend);
        assert_eq!(plan.days[0].entries[0].minutes, 300);
        assert_eq!(plan.days[0].entries[1].kind, TimeLogType::Frontend);
        assert_eq!(plan.days[0].entries[1].minutes, 30);
        assert_eq!(plan.days[1].entries[0].kind, TimeLogType::Frontend);
        assert_eq!(plan.days[1].entries[0].minutes, 150);
        assert_eq!(plan.days[1].entries[1].kind, TimeLogType::Backend);
        assert_eq!(plan.days[1].entries[1].minutes, 120);
        assert_eq!(plan.days[1].entries[2].kind, TimeLogType::Teste);
        assert_eq!(plan.days[1].entries[2].minutes, 60);
        assert!(plan.days.iter().all(|day| day.total_minutes <= 420));
    }

    #[test]
    fn reports_missing_minutes_without_silently_truncating() {
        let input = TimeLogBatchInput {
            work_item_id: 42,
            start_date: "2026-08-12".into(),
            end_date: "2026-08-12".into(),
            work: vec![work(180, TimeLogType::Backend, "API")],
        };
        let used = BTreeMap::from([(date("2026-08-12"), 360)]);

        let plan = plan_time_logs(&input, &used, date("2026-08-12")).unwrap();

        assert_eq!(plan.scheduled_minutes, 60);
        assert_eq!(plan.missing_minutes, 120);
        assert_eq!(plan.days[0].total_minutes, 420);
    }

    #[test]
    fn an_already_overfilled_day_receives_no_new_minutes() {
        let input = TimeLogBatchInput {
            work_item_id: 42,
            start_date: "2026-08-12".into(),
            end_date: "2026-08-12".into(),
            work: vec![work(60, TimeLogType::Teste, "Testes")],
        };
        let used = BTreeMap::from([(date("2026-08-12"), 500)]);

        let plan = plan_time_logs(&input, &used, date("2026-08-12")).unwrap();

        assert_eq!(plan.days[0].existing_minutes, 500);
        assert_eq!(plan.days[0].new_minutes, 0);
        assert_eq!(plan.missing_minutes, 60);
    }

    #[test]
    fn skips_exhausted_days_and_preserves_work_after_capacity_runs_out() {
        let input = TimeLogBatchInput {
            work_item_id: 42,
            start_date: "2026-08-10".into(),
            end_date: "2026-08-13".into(),
            work: vec![
                work(20, TimeLogType::Backend, "API"),
                work(15, TimeLogType::Frontend, "Tela"),
                work(60, TimeLogType::Teste, "Testes"),
            ],
        };
        let used = BTreeMap::from([
            (date("2026-08-10"), 410),
            (date("2026-08-11"), 420),
            (date("2026-08-12"), 500),
            (date("2026-08-13"), 400),
        ]);
        let plan = plan_time_logs(&input, &used, date("2026-08-13")).unwrap();
        assert_eq!(plan.scheduled_minutes, 30);
        assert_eq!(plan.missing_minutes, 65);
        assert_eq!(plan.days[0].entries[0].minutes, 10);
        assert!(plan.days[1].entries.is_empty());
        assert!(plan.days[2].entries.is_empty());
        assert_eq!(
            plan.days[3]
                .entries
                .iter()
                .map(|entry| (entry.kind, entry.minutes))
                .collect::<Vec<_>>(),
            [(TimeLogType::Backend, 10), (TimeLogType::Frontend, 10)]
        );
    }

    #[test]
    fn joins_titles_when_same_type_returns_to_the_same_day() {
        let input = TimeLogBatchInput {
            work_item_id: 42,
            start_date: "2026-08-12".into(),
            end_date: "2026-08-12".into(),
            work: vec![
                work(60, TimeLogType::Backend, "API"),
                work(60, TimeLogType::Frontend, "Tela"),
                work(60, TimeLogType::Backend, "Serviço"),
            ],
        };

        let plan = plan_time_logs(&input, &BTreeMap::new(), date("2026-08-12")).unwrap();

        assert_eq!(plan.days[0].entries.len(), 2);
        assert_eq!(plan.days[0].entries[0].minutes, 120);
        assert_eq!(plan.days[0].entries[0].comment, "API; Serviço");
        assert_eq!(plan.days[0].entries[1].comment, "Tela");
    }

    #[test]
    fn validates_ranges_and_future_dates() {
        let mut input = TimeLogBatchInput {
            work_item_id: 42,
            start_date: "2026-08-13".into(),
            end_date: "2026-08-12".into(),
            work: vec![work(60, TimeLogType::Backend, "API")],
        };
        assert!(plan_time_logs(&input, &BTreeMap::new(), date("2026-08-12")).is_err());

        input.start_date = "2026-08-12".into();
        input.end_date = "2026-08-13".into();
        assert!(plan_time_logs(&input, &BTreeMap::new(), date("2026-08-12")).is_err());

        input.start_date = "data".into();
        input.end_date = "2026-08-12".into();
        assert!(plan_time_logs(&input, &BTreeMap::new(), date("2026-08-12")).is_err());
    }

    #[test]
    fn a_weekend_only_range_has_no_capacity() {
        let input = TimeLogBatchInput {
            work_item_id: 42,
            start_date: "2026-08-08".into(),
            end_date: "2026-08-09".into(),
            work: vec![work(60, TimeLogType::Teste, "Testes")],
        };

        let plan = plan_time_logs(&input, &BTreeMap::new(), date("2026-08-09")).unwrap();

        assert!(plan.days.is_empty());
        assert_eq!(plan.missing_minutes, 60);
    }
}
