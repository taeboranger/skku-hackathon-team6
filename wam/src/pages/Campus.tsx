import { useState } from 'react'
import { useCallFunction } from '@channel.io/app-sdk-wam'
import { useTutorialWamData } from '../hooks/useTutorialWamData'

type Question = {
  id: string
  title: string
  department: string
  realtime: number
  answerCount: number
  status: string
}
export default function Campus() {
  const { data } = useTutorialWamData()
  const { call, loading } = useCallFunction<{ questions: Question[] }>({
    appId: data?.appId || '',
    name: 'campus.listQuestions',
  })
  const [questions, setQuestions] = useState<Question[]>([])
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  return (
    <section style={{ padding: '16px 0', borderTop: '1px solid #ddd' }}>
      <h2>스꾸핑 질문 현황</h2>
      <button
        disabled={loading || !data}
        onClick={() => {
          setError('')
          void call({})
            .then((result) => {
              setQuestions(result.questions)
              setLoaded(true)
            })
            .catch(() =>
              setError(
                '질문 목록을 불러오지 못했습니다. DB 마이그레이션과 Function 등록을 확인하세요.'
              )
            )
        }}
      >
        {loading ? '불러오는 중…' : '최근 질문 불러오기'}
      </button>
      {error && <p role="alert">{error}</p>}
      {loaded && !questions.length && <p>아직 등록된 질문이 없습니다.</p>}
      {questions.map((q) => (
        <article key={q.id}>
          <h3>
            {q.realtime ? '⚡ ' : ''}
            {q.title}
          </h3>
          <p>
            {q.department} · 답변 {q.answerCount} ·{' '}
            {q.status === 'closed' ? '해결' : '답변 대기'}
          </p>
        </article>
      ))}
    </section>
  )
}
