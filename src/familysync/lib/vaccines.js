// Childhood part of Argentina's Calendario Nacional de Vacunación, as a starting
// point. Each entry is editable afterwards: always check it against the
// child's vaccination card and the pediatrician. Vaccines only for some regions
// (yellow fever) are left out and added by hand.
const { addMonths, today } = require('./dates');

const SCHEDULE = [
  { months: 0, name: 'BCG', dose: 'Única' },
  { months: 0, name: 'Hepatitis B', dose: 'Neonatal' },
  { months: 2, name: 'Neumococo conjugada', dose: '1ª dosis' },
  { months: 2, name: 'Quíntuple (pentavalente)', dose: '1ª dosis' },
  { months: 2, name: 'Polio IPV (Salk)', dose: '1ª dosis' },
  { months: 2, name: 'Rotavirus', dose: '1ª dosis' },
  { months: 3, name: 'Meningococo conjugada', dose: '1ª dosis' },
  { months: 4, name: 'Neumococo conjugada', dose: '2ª dosis' },
  { months: 4, name: 'Quíntuple (pentavalente)', dose: '2ª dosis' },
  { months: 4, name: 'Polio IPV (Salk)', dose: '2ª dosis' },
  { months: 4, name: 'Rotavirus', dose: '2ª dosis' },
  { months: 5, name: 'Meningococo conjugada', dose: '2ª dosis' },
  { months: 6, name: 'Quíntuple (pentavalente)', dose: '3ª dosis' },
  { months: 6, name: 'Polio IPV (Salk)', dose: '3ª dosis' },
  { months: 6, name: 'Antigripal', dose: '1ª dosis (anual hasta los 2 años)' },
  { months: 12, name: 'Neumococo conjugada', dose: 'Refuerzo' },
  { months: 12, name: 'Triple viral', dose: '1ª dosis' },
  { months: 12, name: 'Hepatitis A', dose: 'Única' },
  { months: 15, name: 'Meningococo conjugada', dose: 'Refuerzo' },
  { months: 15, name: 'Varicela', dose: '1ª dosis' },
  { months: 18, name: 'Quíntuple (pentavalente)', dose: 'Refuerzo' },
  { months: 60, name: 'Polio IPV (Salk)', dose: 'Refuerzo (ingreso escolar)' },
  { months: 60, name: 'Triple viral', dose: '2ª dosis (ingreso escolar)' },
  { months: 60, name: 'Triple bacteriana celular', dose: 'Refuerzo (ingreso escolar)' },
  { months: 60, name: 'Varicela', dose: '2ª dosis (ingreso escolar)' },
  { months: 132, name: 'Triple bacteriana acelular', dose: 'Refuerzo (11 años)' },
  { months: 132, name: 'VPH', dose: 'Única (11 años)' },
  { months: 132, name: 'Meningococo ACYW', dose: 'Refuerzo (11 años)' },
];

// Vaccines a member is missing from the schedule, with their due dates.
// markPastApplied marks the ones already due as applied on their due date.
function planFor(member, existing, { markPastApplied = false, now = today() } = {}) {
  if (!member.birthDate) {
    throw Object.assign(new Error(`Cargá la fecha de nacimiento de ${member.name} primero`), { status: 400 });
  }
  const have = new Set(existing.filter((v) => v.memberId === member.id).map((v) => `${v.name}|${v.dose}`));
  return SCHEDULE.filter((s) => !have.has(`${s.name}|${s.dose}`)).map((s) => {
    const dueDate = addMonths(member.birthDate, s.months);
    return {
      memberId: member.id,
      name: s.name,
      dose: s.dose,
      dueDate,
      appliedDate: markPastApplied && dueDate <= now ? dueDate : undefined,
    };
  });
}

module.exports = { SCHEDULE, planFor };
