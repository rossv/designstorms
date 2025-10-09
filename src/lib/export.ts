import type { StormResult } from './types'

export function saveCsv(storm: StormResult, filename='design_storm.csv') {
  const header = 'time_min,incremental_in,cumulative_in,intensity_in_hr\n'
  const rows = storm.timeMin.map((t,i)=> `${t},${storm.incrementalIn[i]},${storm.cumulativeIn[i]},${storm.intensityInHr[i]}`).join('\n')
  downloadText(header + rows, filename)
}

export function savePcswmmDat(storm: StormResult, timestepMin: number, filename='design_storm.dat', gauge='System', startISO='2003-01-01T00:00:00Z') {
  const start = new Date(startISO)
  let txt = ';Rainfall (in/hr)\n;PCSWMM generated rain gauges file (please do not edit)\n'
  for (let i=0;i<storm.intensityInHr.length;i++) {
    const ts = new Date(start.getTime() + (i+1)*timestepMin*60*1000)
    const y=ts.getUTCFullYear(), mo=ts.getUTCMonth()+1, d=ts.getUTCDate(), h=ts.getUTCHours(), m=ts.getUTCMinutes()
    txt += `${gauge}\t${y}\t${mo}\t${d}\t${h}\t${m}\t${storm.intensityInHr[i].toPrecision(7)}\n`
  }
  downloadText(txt, filename)
}

function downloadText(text: string, filename: string) {
  const blob = new Blob([text], {type: 'text/plain'})
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  document.body.appendChild(a)
  a.click()
  setTimeout(()=>{
    URL.revokeObjectURL(a.href)
    a.remove()
  }, 0)
}
