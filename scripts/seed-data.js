/**
 * seed-data.js
 *
 * Transforms real-crns-must-not-add-to-git.json into the flat format expected
 * by k6 scenarios and writes the first 100 entries to src/data/frps-applicants.json.
 *
 * Usage:
 *   npm run seed-data
 *
 * The source file and output file are both gitignored — never commit either.
 */

import { readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const SOURCE = resolve(__dirname, '../src/data/real-crns-must-not-add-to-git.json')
const OUTPUT = resolve(__dirname, '../src/data/frps-applicants.json')
const LIMIT = 100

const raw = JSON.parse(readFileSync(SOURCE, 'utf8'))

const applicants = raw.people
  .slice(0, LIMIT)
  .map((p) => ({
    crn: p.crn,
    firstName: p.firstName,
    lastName: p.lastName,
    sbi: p.organisations[0].sbi,
    organisationId: p.organisations[0].organisationId,
    name: p.organisations[0].name,
  }))

writeFileSync(OUTPUT, JSON.stringify(applicants, null, 2))
console.log(`Wrote ${applicants.length} applicants to ${OUTPUT}`)
