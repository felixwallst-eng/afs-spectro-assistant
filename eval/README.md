# Pilottest: Fall-Dimensionen-Klassifikator (v0.1)

Ziel: Bis Samstagvormittag entscheiden, ob (a) die Fall-Dimensionen die Entwicklungsfälle tragen und ob (b) Jev sie zuverlässig genug klassifiziert. Alternativ übernimmt ein LLM mit strukturierter Ausgabe die Klassifikation.

## Dateien

| Datei | Inhalt |
|---|---|
| `dimensions.yaml` | 17 Fall-Dimensionen: typisierte Klassifikator-Frage, Labels mit Beschreibung, Unknown-Label, Priorität, Rückfrage-Vorlage, betroffene Regeln, Quellen |
| `gold_labels_dev.json` | Entwurf der Goldstandard-Labels für **D01–D08** mit Begründung bei unklaren Fällen |
| `cases.json` | Kundentexte D01–D08 (`split: dev`) und H01–H06 (`split: test`) als Eingabe für den Runner |
| `eval_pilot.py` | Auswertung: Genauigkeit, Fehlsicherheit, Übervorsicht, Wiederholbarkeit, Kalibrierung, Schwellen-Sweep, Cohens Kappa |

## Design-Prinzipien

- **Der Klassifikator beschreibt den Fall, nicht die Methoden.** Die Bewertung der Methoden übernimmt später die Regel-Engine aus diesen Labels plus der Wissensmatrix. So entstehen Zitationen deterministisch.
- **`fact` vs. `request`:**
  - Nicht genannte *Fakten* gelten als unbekannt und erzeugen Rückfragen.
  - Nicht genannte *Wünsche* wurden schlicht nicht geäußert und erzeugen keine Frage.
- **Jede Fakt-Dimension hat ein explizites Unknown-Label.** Zusätzlich gilt: Eine Konfidenz unter dem Schwellwert wird als unbekannt gewertet.
- **Zwei Fehlerarten werden getrennt gemessen:**
  - *False certainty:* Der Klassifikator behauptet etwas, das nicht im Text steht. Das ist gefährlich.
  - *Over-caution:* Der Klassifikator sagt „unbekannt“, obwohl es im Text steht. Das ist sicher, aber lästig.
  - Ziel: False certainty nahe 0, Over-caution akzeptabel klein.
- **H01–H06 sind das Testset.** Sie werden nicht gelabelt und nicht zum Tunen benutzt, bis Prompts und Regeln eingefroren sind. Das gehört so ins README des Repos und ins Video.

## Ablauf (max. 2–3 h)

1. **Unabhängig labeln (30 min):** Einer von euch prüft `gold_labels_dev.json`. Der andere labelt D01–D08 *ohne hineinzuschauen* in eine Kopie (`gold_labels_dev_B.json`). Dann:
   `python eval_pilot.py --gold2 gold_labels_dev_B.json`
   Daraus ergibt sich die menschliche Übereinstimmung, also die Obergrenze für jedes Modell. Abweichungen klärt ihr und schärft die Label-Beschreibungen in der YAML nach.
2. **Runner schreiben (45 min):** Für jeden Fall in `cases.json` und jede Dimension wird eine Jev-Anfrage gestellt:
   - `choice`-Dimensionen über einen Choice-Call
   - `multi_flag`-Dimensionen über einen Yes/No-Call pro Flag
   - Pro Lauf entsteht eine Datei `runs/jev_runN.json` im Format, das im Docstring von `eval_pilot.py` steht.
   - Kontext für Jev: der Kundentext plus Klassifikator-Frage und Label-Beschreibungen.
3. **10 Läufe** auf dem Split `dev`, dasselbe einmal mit einem LLM (structured output, Temperatur 0).
4. **Auswerten:**
   `python eval_pilot.py --runs runs/jev_run*.json` (und das Gleiche für die LLM-Läufe)

## Go/No-Go-Vorschlag (vor dem Test festlegen!)

| Kriterium | Go wenn |
|---|---|
| Darstellbarkeit | Alle 8 D-Fälle lassen sich ohne „passt nicht“-Notizen labeln |
| Menschliche Übereinstimmung (Choice-Kappa) | ≥ 0,8, sonst sind die Dimensionen unscharf, nicht das Modell |
| Genauigkeit gesamt | ≥ 0,85 |
| False certainty | ≤ 0,03 bei gewähltem Schwellwert |
| Wiederholbarkeit | ≥ 0,98 |

- Wenn Jev durchfällt, das LLM aber besteht: Klassifikator tauschen, die Architektur bleibt.
- Wenn beide durchfallen: Die Dimensionen überarbeiten, nicht das Modell.

## Offene Punkte

- **Grenzfälle in den Gold-Labels** stehen unter `ambiguous`, zum Beispiel D03 (klar oder trüb), D04 (Optik nicht genannt) und D02 (Textur oder Optik). Legt eine Konvention fest und bleibt dabei.
- **Ein `dev`-Fall mit mehreren Strömen (`multiple_distinct_matrices`)** fehlt noch. Ebenso fehlen Fälle mit Wiederverwendungs- oder Genehmigungswünschen. Damit diese Labels im Test nicht ungeprüft bleiben, solltet ihr 6–10 **eigene Varianten der D-Fälle** schreiben, zum Beispiel „D02 + D03 in einer Anfrage“ oder „D06 mit vorhandener Faser“. Wichtig: abgeleitet aus D, nicht aus H.
- **Der Konfidenz-Schwellwert 0,70** ist ein Platzhalter. Wählt ihn anhand des Schwellen-Sweeps.
